import { parseResponse, DetailedError } from 'hono/client';
import { WS_CLOSE_RESTART } from '../../../shared/protocol';
import type { ClientMessage, RoomSnapshot } from '../../../shared/protocol';
import { client } from '../../app/client';
import { closeInfo, parseServerMessage, type CloseInfo } from './room-wire';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomConnectionHandlers {
  onSnapshot(snapshot: RoomSnapshot, meta: { reconnected: boolean }): void;
  onServerError(message: string): void;
  onServerNow(serverNow: number): void;
  onState(state: ConnectionState): void;
  onClosed(info: CloseInfo): void;
  onReconnectAttempt(attempt: number, delayMs: number): void;
}

/** Client-local code for dropping a socket that went silent (never sent by the server). */
const CLOSE_STALE = 4009;

const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 70_000;
const MAX_BACKOFF_MS = 8_000;

/**
 * One authenticated socket per room. It reconnects on its own (the server
 * replaces the old connection with the new one and replays authoritative
 * state), keeps the server clock calibrated from pongs, and never treats a
 * rejected session or a vanished room as a transient failure.
 */
export class RoomConnection {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private everOpened = false;
  private openIsReconnect = false;
  private stopped = false;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private lastMessageAt = 0;

  constructor(
    private readonly roomId: string,
    private readonly handlers: RoomConnectionHandlers,
  ) {
    window.addEventListener('online', this.retryNow);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  open(): void {
    if (this.socket || this.stopped) return;
    this.connect();
  }

  /** Returns false when the socket is not open — the caller keeps the message in the UI. */
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.stopped = true;
    this.teardownTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, 'client closed');
    this.setState('closed');
  }

  destroy(): void {
    this.close();
    window.removeEventListener('online', this.retryNow);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private readonly retryNow = (): void => {
    if (this.stopped || this.state === 'open') return;
    this.clearReconnect();
    this.connect();
  };

  private readonly handleOffline = (): void => {
    if (this.stopped) return;
    this.setState('reconnecting');
  };

  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'visible' && !this.stopped && this.state !== 'open') {
      this.retryNow();
    }
  };

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/api/rooms/${encodeURIComponent(this.roomId)}/ws`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.openIsReconnect = this.everOpened;
      this.everOpened = true;
      this.lastMessageAt = Date.now();
      this.setState('open');
      this.startPing();
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === 'state') {
        const reconnected = this.openIsReconnect;
        this.openIsReconnect = false;
        this.handlers.onSnapshot(message.room, { reconnected });
      } else if (message.type === 'error') {
        this.handlers.onServerError(message.message);
      } else {
        this.handlers.onServerNow(message.serverNow);
      }
    });

    socket.addEventListener('error', () => {
      // The close handler drives reconnection; errors alone are not actionable.
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.teardownPing();
      if (this.stopped) {
        this.setState('closed');
        return;
      }
      const info = closeInfo(event.code, event.reason || '');
      this.openIsReconnect = false;
      if (info.authExpired || info.replaced || info.roomClosed) {
        this.handlers.onClosed(info);
        this.setState('closed');
        return;
      }
      if (event.code === WS_CLOSE_RESTART) {
        // Recoverable server restart: back off and reconnect without probing.
        this.scheduleReconnect();
        return;
      }
      // Unknown failure (a rejected handshake surfaces as 1006 with no reason):
      // ask the API whether the session or the room is still usable first.
      void this.retryAfterDiagnosis(info);
    });
  }

  private async retryAfterDiagnosis(info: CloseInfo): Promise<void> {
    const diagnosis = await this.diagnose();
    if (this.stopped) return;
    if (diagnosis === 'auth') {
      this.handlers.onClosed({ ...info, authExpired: true });
      this.setState('closed');
      return;
    }
    if (diagnosis === 'room') {
      this.handlers.onClosed({ ...info, roomClosed: true });
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  /** After an unexplained close, is the session still valid and the room still open? */
  private async diagnose(): Promise<'ok' | 'auth' | 'room'> {
    try {
      const session = await parseResponse(client.api.session.$get());
      if (!session.user) return 'auth';
    } catch (error) {
      return error instanceof DetailedError && error.statusCode === 401 ? 'auth' : 'ok';
    }
    try {
      await parseResponse(client.api.rooms[':roomId'].$get({ param: { roomId: this.roomId } }));
      return 'ok';
    } catch (error) {
      if (!(error instanceof DetailedError)) return 'ok';
      if (error.statusCode === 401) return 'auth';
      if (error.statusCode === 404 || error.statusCode === 403 || error.statusCode === 409)
        return 'room';
      return 'ok';
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt += 1;
    this.handlers.onReconnectAttempt(this.attempt, delay);
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.teardownPing();
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
        this.socket.close(CLOSE_STALE, 'stale');
        return;
      }
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private teardownPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownTimers(): void {
    this.clearReconnect();
    this.teardownPing();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }
}
