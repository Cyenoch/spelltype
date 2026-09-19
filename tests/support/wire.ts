/**
 * 供测试使用的线上观测：页面自身 Socket 在两个方向上承载的每一帧，
 * 以及页面收到的关闭码。
 *
 * 仅属于测试侧观测 —— 这里不会向产品添加任何内容。
 * 帧通过协议自身的类型读回（客户端联合类型由其规范 schema 校验），
 * 因此捕获到的就是字面上的线路数据，泄漏或静默重连无法躲在渲染层之后。
 */
import type { Page } from '@playwright/test';
import { WS_PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { clientMessageSchema } from '../../shared/validation';

declare global {
  interface Window {
    /** 由 {@link captureCloseCodes} 在页面第一个脚本运行之前安装。 */
    __reportSocketClose: (code: number) => void;
  }
}

export interface SocketCapture {
  frames: { at: number; direction: 'sent' | 'received'; payload: string }[];
}

/**
 * 记录页面自身 Socket 的 WebSocket 关闭码。必须在页面导航之前安装
 * （单页应用只加载一次）。
 */
export async function captureCloseCodes(page: Page): Promise<() => Promise<number[]>> {
  const codes: number[] = [];
  await page.exposeFunction('__reportSocketClose', (code: number) => {
    codes.push(code);
  });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    class Tracked extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        this.addEventListener('close', (event) => window.__reportSocketClose(event.code));
      }
    }
    window.WebSocket = Tracked;
  });
  return async () => codes.slice();
}

/**
 * 记录页面上的每一个 WebSocket 帧（双向）。请在页面导航或建立连接之前挂载：
 * 只有监听器挂载之后创建的 Socket 才会被捕获。
 */
export function captureSockets(page: Page): SocketCapture {
  const capture: SocketCapture = { frames: [] };
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) =>
      capture.frames.push({ at: Date.now(), direction: 'sent', payload: String(event.payload) }),
    );
    socket.on('framereceived', (event) =>
      capture.frames.push({
        at: Date.now(),
        direction: 'received',
        payload: String(event.payload),
      }),
    );
  });
  return capture;
}

function frames(capture: SocketCapture, direction: 'sent' | 'received') {
  return capture.frames.filter((frame) => frame.direction === direction);
}

/** 只包含服务端发送给本页面的内容：权威的隐私边界。 */
export function receivedText(capture: SocketCapture): string {
  return frames(capture, 'received')
    .map((frame) => frame.payload)
    .join('\n');
}

/** 解析后的帧值；当载荷根本不是 JSON 时为 `null`。 */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** 协议的三种服务端消息，通过联合类型自身的判别字段识别。 */
function serverMessage(payload: string): ServerMessage | null {
  const value = parseJson(payload);
  if (value === null || typeof value !== 'object' || !('type' in value)) return null;
  const { type } = value;
  if (type !== 'state' && type !== 'error' && type !== 'pong') return null;
  // 判别字段是联合类型自身的键；帧的其余部分即应用在其线路上的输出。
  return value as ServerMessage;
}

export interface ReceivedFrame {
  at: number;
  payload: string;
  /** 该帧携带的服务端消息；若不是服务端消息则为 `null`。 */
  message: ServerMessage | null;
}

/** 解析后的服务端帧，使阶段与战斗状态可直接依据载荷本身判定。 */
export function receivedFrames(capture: SocketCapture): ReceivedFrame[] {
  return frames(capture, 'received').map((frame) => ({
    at: frame.at,
    payload: frame.payload,
    message: serverMessage(frame.payload),
  }));
}

/** 解析后的客户端帧，使测试可以针对其发送的确切输入契约做断言。 */
export function sentMessages(capture: SocketCapture): ClientMessage[] {
  return frames(capture, 'sent').flatMap((frame) => {
    const message = clientMessageSchema.safeParse(parseJson(frame.payload));
    return message.success ? [message.data] : [];
  });
}

/** 每个客户端 —— 应用自身的与原始探针 —— 都使用的稳定房间 WebSocket 路径。 */
function roomSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/ws`;
}

/** 通过一条新建 Socket 发送原始房间帧（用于重放/截断输入检查）。
 *
 * 该 Socket 使用与客户端相同的稳定 WS 路径，
 * 因此服务端自身的准入检查会像对待其他客户端一样对待它。
 * 除非调用方明确要求另一种握手，否则它以当前的 `WS_PROTOCOL` 子协议打开：
 * `protocols: []`（无子协议）或错误的令牌会触发服务端的协议拒绝。
 * 帧按原文送达 —— 调用方传入的陈旧 `draftEpoch` 或 `spellIndex` 会原样发送，
 * 绝不升级为房间当前的身份。
 */
export async function sendRawMessages(
  page: Page,
  roomId: string,
  messages: ClientMessage[],
  options: { protocols?: string[] } = {},
): Promise<void> {
  await page.evaluate(
    ({ path, messages: payload, protocols }) =>
      new Promise<void>((resolve) => {
        const socket =
          protocols.length > 0
            ? new WebSocket(`ws://${location.host}${path}`, protocols)
            : new WebSocket(`ws://${location.host}${path}`);
        socket.onopen = () => {
          for (const message of payload) socket.send(JSON.stringify(message));
          setTimeout(() => {
            socket.close();
            resolve();
          }, 1200);
        };
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
        setTimeout(() => resolve(), 8000);
      }),
    {
      path: roomSocketPath(roomId),
      messages,
      protocols: options.protocols ?? [WS_PROTOCOL],
    },
  );
}

export interface RawSocketProbe {
  /** 服务端是否曾经接受该升级请求。 */
  opened: boolean;
  /** 页面观测到的关闭码（若有）；被拒绝的握手表现为 `1006` 式的无码关闭。 */
  closeCode: number | null;
  /** 该 Socket 上收到的服务端原始载荷，按到达顺序排列。 */
  received: string[];
}

/**
 * 打开一条原始房间 Socket 并报告握手/关闭结果。供协议测试使用：
 * 错误或缺失的子协议绝不可到达 `opened`，
 * 而被房间撤销的陈旧协议 Socket 会报告房间自身的关闭码（4003/4004）。
 *
 * 该 Socket 使用与客户端相同的稳定 WS 路径，
 * 因此服务端自身的准入检查会像对待其他客户端一样对待它。
 * Socket 打开后，`send` 载荷按原文送达 ——
 * 它们由调用方字符串化，因此一个刻意畸形的帧（缺少必需 `draftEpoch` 的输入）
 * 会完全按书写的样子发送，绝不被修补成合法消息。
 */
export async function openRawSocket(
  page: Page,
  roomId: string,
  options: { protocols?: string[]; holdMs?: number; send?: unknown[] } = {},
): Promise<RawSocketProbe> {
  return page.evaluate(
    ({ path, protocols, holdMs, send }) =>
      new Promise<RawSocketProbe>((resolve) => {
        const probe: RawSocketProbe = { opened: false, closeCode: null, received: [] };
        const socket =
          protocols.length > 0
            ? new WebSocket(`ws://${location.host}${path}`, protocols)
            : new WebSocket(`ws://${location.host}${path}`);
        const finish = () => {
          try {
            socket.close();
          } catch {
            /* 已关闭 */
          }
          resolve(probe);
        };
        socket.onopen = () => {
          probe.opened = true;
          for (const payload of send ?? []) socket.send(JSON.stringify(payload));
          setTimeout(finish, holdMs ?? 400);
        };
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') probe.received.push(event.data);
        };
        socket.onclose = (event) => {
          probe.closeCode = event.code;
          resolve(probe);
        };
        socket.onerror = () => {
          if (!probe.opened) resolve(probe);
        };
        setTimeout(() => resolve(probe), 8000);
      }),
    {
      path: roomSocketPath(roomId),
      protocols: options.protocols ?? [WS_PROTOCOL],
      holdMs: options.holdMs,
      send: options.send,
    },
  );
}
