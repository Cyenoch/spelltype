import { api, ApiError } from './api';
import { WS_CLOSE, WS_CLOSE_RESTART } from '../shared/protocol';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../shared/protocol';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface CloseInfo {
  code: number;
  reason: string;
  /** The session was rejected: re-authentication is required. */
  authExpired: boolean;
  /** Another connection for the same account took over this seat. */
  replaced: boolean;
  /** The room is gone or no longer admits this player. */
  roomClosed: boolean;
}

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
const AUTH_CLOSE_CODES: Record<number, true> = { 1008: true, 4401: true, 4403: true };

const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 70_000;
const MAX_BACKOFF_MS = 8_000;

function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (type === 'state' || type === 'error' || type === 'pong') return value as ServerMessage;
  return null;
}

function closeInfo(code: number, reason: string): CloseInfo {
  return {
    code,
    reason,
    authExpired: AUTH_CLOSE_CODES[code] === true || code === WS_CLOSE.sessionExpired,
    replaced: code === WS_CLOSE.replaced,
    roomClosed: code === WS_CLOSE.closed,
  };
}

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

  /** Politely leave: the message needs a flushed frame before the socket closes. */
  leave(): boolean {
    const sent = this.send({ type: 'leave' });
    this.stopped = true;
    window.setTimeout(() => this.close(), sent ? 900 : 0);
    return sent;
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

  private async diagnose(): Promise<'ok' | 'auth' | 'room'> {
    try {
      const session = await api.session();
      if (!session.user) return 'auth';
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) return 'auth';
      return 'ok';
    }
    try {
      await api.room(this.roomId);
      return 'ok';
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.isAuthFailure) return 'auth';
        if (error.status === 404 || error.status === 409 || error.status === 403) return 'room';
        return 'ok';
      }
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
