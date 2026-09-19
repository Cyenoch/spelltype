import { parseResponse, DetailedError } from 'hono/client';
import { WS_CLOSE_RESTART, WS_PROTOCOL } from '../../../shared/protocol';
import type { ClientMessage, RoomSnapshot } from '../../../shared/protocol';
import { client } from '../../app/client';
import {
  closeInfo,
  isProtocolRejection,
  parseServerMessage,
  type CloseInfo,
  type Diagnosis,
} from './room-wire';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomConnectionHandlers {
  onSnapshot(snapshot: RoomSnapshot, meta: { reconnected: boolean }): void;
  onServerError(message: string): void;
  onServerNow(serverNow: number): void;
  onState(state: ConnectionState): void;
  onClosed(info: CloseInfo): void;
  onReconnectAttempt(attempt: number, delayMs: number): void;
}

/** 客户端本地关闭码，用于主动断开无响应的 Socket（服务端绝不发送此码）。 */
const CLOSE_STALE = 4009;

const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 70_000;
const MAX_BACKOFF_MS = 8_000;
/**
 * 输入过载重置（关闭码 4004）后的重连保护下限时间：
 * 所有重连触发器（定时器、retryNow、上线事件、页面可见性）在尝试建立新 Socket 前，
 * 均须等待该保护期限结束，防止获焦事件打破退避机制反复冲击房间。
 */
const OVERLOAD_RECONNECT_FLOOR_MS = 1_000;

/**
 * 每个房间唯一的已认证 WebSocket 连接，位于固定的 `/api/rooms/:id/ws` 路径。
 * 它能够自动重连（服务端会使用新连接替换旧连接并回放权威状态），
 * 通过 pong 消息持续校准服务端时钟，且绝不会把被拒绝的会话或已销毁的房间视为临时偶发故障。
 *
 * Socket 创建时声明了线协议子协议：若服务端不再支持当前页面的协议版本，
 * 会在握手阶段直接拒绝，随后的诊断逻辑会将其转为明确的页面刷新提示，而非陷入死循环重连。
 * 协议版本不匹配关闭（4003）自身即属于终态；输入过载关闭（4004）会重新连接，但绝不会早于保护下限时间。
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
  /** 允许打开新 Socket 的最早时刻；仅在过载重置后为非零时间戳。 */
  private reconnectNotBefore = 0;
  /**
   * 连接代数纪元（generation）：每次创建新 Socket 或主动终止连接时递增。
   * 异步诊断逻辑在启动时会捕获当前的 token；若返回结果时的 token 与之不一致，
   * 说明该结果属于已销毁的连接，直接废弃以防覆盖新 Socket 的状态。
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

  /** 当 Socket 未就绪时返回 false——由调用方负责在 UI 中保留该待发消息。 */
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
    // 设备离线并不能可靠触发已有 WebSocket 的 close 事件。保留废弃 Socket
    // 会阻碍网络恢复/页面可见时的重试，并妨碍权威草稿的恢复。
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
    // 此处强制校验过载保护下限，而不仅在重试调度器中校验，
    // 确保任何触发源（上线、可见性变更、手动 open）都无法提前发起连接。
    if (Date.now() < this.reconnectNotBefore) {
      this.scheduleReconnect();
      return;
    }
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 固定路径本身不携带客户端身份信息：线协议子协议包含了完整的握手版本声明，
    // 若服务端版本与客户端不匹配，会在握手阶段直接拒绝。
    const url = `${scheme}//${location.host}/api/rooms/${encodeURIComponent(this.roomId)}/ws`;

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
      // close 事件处理器负责驱动重连逻辑；单凭 error 事件本身无法采取有效行动。
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
        // 终态：当前页面的线协议版本已被服务端弃用。禁止任何触发源重连。
        this.stopped = true;
        this.generation += 1;
        this.teardownTimers();
        this.handlers.onClosed(info);
        this.setState('closed');
        return;
      }
      if (info.inputOverload) {
        // 允许重连，但绝不能落在同一配额时间窗口内：保护下限
        // 会同时对下方的调度器和所有直接触发源生效。
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
        // 可恢复的服务端重启：执行退避并重连。
        // 若房间真正结束，服务端会以专用的终态关闭码关闭连接。
        this.scheduleReconnect();
        return;
      }
      // 未知失败（握手被拒绝通常表现为无原因的 1006 异常关闭）：
      // 在盲目重试前，先调用 API 诊断当前会话、房间或协议是否依然可用。
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
        client.api.rooms[':roomId'].$get({ param: { roomId: this.roomId } }),
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
