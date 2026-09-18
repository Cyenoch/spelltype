import { parseResponse, DetailedError } from 'hono/client';
import { WS_CLOSE_RESTART, WS_PROTOCOL } from '../../../shared/protocol';
import type { ClientMessage, RoomSnapshot } from '../../../shared/protocol';
import { gameApiBase } from '../../../shared/release';
import { client, gameClient } from '../../app/client';
import {
  closeInfo,
  isProtocolRejection,
  parseServerMessage,
  type CloseInfo,
  type Diagnosis,
} from './room-wire';
import { RELEASE_ID } from '../../app/release-id';
import { resolveRoomEntry } from './room-entry';

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
 * Floor for reconnecting after an input-overload reset (close 4004): every
 * reconnect trigger — timer, retryNow, online, visibility — waits out the same
 * deadline before a new socket may even be attempted, so a focus event cannot
 * outrun the backoff and hammer the room again.
 */
const OVERLOAD_RECONNECT_FLOOR_MS = 1_000;

/**
 * One authenticated socket per room. Before every connection attempt the stable
 * room locator decides whether this bundle may attach at all: a room retained
 * by another release receives the whole document (a full-page entry of that
 * room's own build), a retired room ends the connection for good. Within its
 * own release it reconnects on its own (the server replaces the old connection
 * with the new one and replays authoritative state), keeps the server clock
 * calibrated from pongs, and never treats a rejected session or a vanished room
 * as a transient failure.
 *
 * The socket is created with the wire protocol subprotocol: a server that no
 * longer speaks this page's version refuses the handshake, and the diagnosis
 * that follows turns that into a terminal update-required state instead of a
 * reconnect loop. A protocol-mismatch close (4003) is terminal on its own;
 * an input-overload close (4004) reconnects, but never sooner than the floor.
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
  /** Earliest instant a new socket may be opened; nonzero only after an overload reset. */
  private reconnectNotBefore = 0;
  /**
   * Connection generation: bumped by every new socket and by termination. An
   * async diagnosis captured the token when it started; a result that comes
   * back under a different token belongs to a connection that no longer exists
   * and is dropped instead of clobbering the newer socket's state.
   */
  private generation = 0;

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
    if (this.stopped || this.socket) return;
    void this.connect();
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
    this.generation += 1;
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
    if (this.stopped || this.state === 'open' || this.socket) return;
    this.clearReconnect();
    void this.connect();
  };

  private readonly handleOffline = (): void => {
    if (this.stopped) return;
    // Offline does not reliably close an existing WebSocket. Retaining it would
    // block every online/visibility retry and prevent authoritative draft recovery.
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.teardownTimers();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(CLOSE_STALE, 'offline');
    this.setState('reconnecting');
  };

  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'visible' && !this.stopped && this.state !== 'open') {
      this.retryNow();
    }
  };

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    // The overload floor is enforced here, not just in the retry scheduler, so
    // no trigger (online, visibility, manual open) can open a socket early.
    if (Date.now() < this.reconnectNotBefore) {
      this.scheduleReconnect();
      return;
    }
    const seq = ++this.generation;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');

    // The stable locator gate: never attach this bundle to a room another
    // release owns, and never reconnect into a room whose release has been
    // retired. An unreachable locator is not proof of anything: retry.
    const entry = await resolveRoomEntry(this.roomId);
    if (this.stopped || seq !== this.generation) return;
    if (entry.kind === 'elsewhere') {
      // The room is retained by its own release. Only a full document load of
      // that release's entry can serve it — this bundle must never attach, so
      // the browser itself is handed over before a single frame is sent.
      this.stopped = true;
      this.setState('closed');
      window.location.assign(entry.location.entryUrl);
      return;
    }
    if (entry.kind === 'retired' || entry.kind === 'gone') {
      this.handlers.onClosed({
        code: 0,
        reason: '',
        authExpired: false,
        replaced: false,
        roomClosed: true,
        protocolMismatch: false,
        inputOverload: false,
        roomRetired: entry.kind === 'retired',
      });
      this.setState('closed');
      return;
    }
    if (entry.kind === 'auth') {
      this.handlers.onClosed({
        code: 0,
        reason: '',
        authExpired: true,
        replaced: false,
        roomClosed: false,
        protocolMismatch: false,
        inputOverload: false,
        roomRetired: false,
      });
      this.setState('closed');
      return;
    }
    // `entry` is `current` — or the locator is unreachable, which proves
    // nothing: this connection only ever exists after the route loaded a
    // snapshot through this bundle's own version-prefixed API, so the room is
    // already this release's by proof, and the handshake below re-validates
    // release identity server-side on every attempt. A healthy game runtime is
    // never held hostage by an unavailable stable API, and a room that in fact
    // moved on is rejected at the handshake rather than served wrong HTML.

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The version prefix and the release query both carry this bundle's
    // identity: the browser cannot set headers on a WebSocket, so the URL is
    // the handshake's release declaration.
    const url =
      `${scheme}//${location.host}${gameApiBase(RELEASE_ID)}` +
      `/rooms/${encodeURIComponent(this.roomId)}/ws?release=${encodeURIComponent(RELEASE_ID)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, WS_PROTOCOL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.generation += 1;

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
      if (info.protocolMismatch) {
        // Terminal: this page's wire version is gone. No trigger may reopen.
        this.stopped = true;
        this.generation += 1;
        this.teardownTimers();
        this.handlers.onClosed(info);
        this.setState('closed');
        return;
      }
      if (info.inputOverload) {
        // Reconnect, but never inside the same quota window: the floor holds
        // against the scheduler below and against every direct trigger.
        this.reconnectNotBefore = Date.now() + OVERLOAD_RECONNECT_FLOOR_MS;
        this.handlers.onClosed(info);
        this.scheduleReconnect();
        return;
      }
      if (info.authExpired || info.replaced || info.roomClosed) {
        this.close();
        this.handlers.onClosed(info);
        return;
      }
      if (event.code === WS_CLOSE_RESTART) {
        // Recoverable server restart: back off and reconnect. The locator gate
        // at the top of `connect` re-checks the room's release first, so a
        // restart that was actually a retirement stops here instead.
        this.scheduleReconnect();
        return;
      }
      // Unknown failure (a rejected handshake surfaces as 1006 with no reason):
      // ask the API whether the session, the room, or the protocol is still
      // usable on this side before retrying.
      void this.retryAfterDiagnosis(info);
    });
  }

  private async retryAfterDiagnosis(info: CloseInfo): Promise<void> {
    const token = this.generation;
    const diagnosis = await this.diagnose();
    if (this.stopped || token !== this.generation) return;
    if (diagnosis === 'auth') {
      this.close();
      this.handlers.onClosed({ ...info, authExpired: true });
      return;
    }
    if (diagnosis === 'room') {
      this.close();
      this.handlers.onClosed({ ...info, roomClosed: true });
      return;
    }
    if (diagnosis === 'protocol') {
      // The server answered the room read with its update-required verdict:
      // same terminal state as a 4003 close, never a reconnect.
      this.stopped = true;
      this.generation += 1;
      this.teardownTimers();
      this.handlers.onClosed({ ...info, protocolMismatch: true });
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  /** After an unexplained close, is the session still valid and the room still open? */
  private async diagnose(): Promise<Diagnosis> {
    try {
      const session = await parseResponse(client.api.session.$get());
      if (!session.user) return 'auth';
    } catch (error) {
      return error instanceof DetailedError && error.statusCode === 401 ? 'auth' : 'ok';
    }
    try {
      const room = await parseResponse(
        gameClient.rooms[':roomId'].$get(
          { param: { roomId: this.roomId } },
          { headers: { 'X-Spelltype-Protocol': WS_PROTOCOL } },
        ),
      );
      return room.protocolVersion === WS_PROTOCOL ? 'ok' : 'protocol';
    } catch (error) {
      if (!(error instanceof DetailedError)) return 'ok';
      if (error.statusCode === 401) return 'auth';
      if (isProtocolRejection(error)) return 'protocol';
      if (error.statusCode === 409 || error.statusCode === 404 || error.statusCode === 403)
        return 'room';
      return 'ok';
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const jittered = Math.round(base * (0.75 + Math.random() * 0.5));
    const floorRemaining = Math.max(0, this.reconnectNotBefore - Date.now());
    const delay = Math.max(jittered, floorRemaining);
    this.attempt += 1;
    this.handlers.onReconnectAttempt(this.attempt, delay);
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
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
