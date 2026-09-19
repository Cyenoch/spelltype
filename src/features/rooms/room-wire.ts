import { DetailedError } from 'hono/client';
import { WS_CLOSE } from '../../../shared/protocol';
import type { ServerMessage } from '../../../shared/protocol';

export interface CloseInfo {
  code: number;
  reason: string;
  /** 会话被拒绝：需要重新鉴权。 */
  authExpired: boolean;
  /** 同一账号的另一条连接顶替了本席位。 */
  replaced: boolean;
  /** 房间已不存在，或不再接纳该玩家。 */
  roomClosed: boolean;
  /** 服务端运行着不同的通信协议：页面必须重新加载。 */
  protocolMismatch: boolean;
  /** 服务端因输入消息过于密集而重置了这条连接。 */
  inputOverload: boolean;
}

const AUTH_CLOSE_CODES: Record<number, true> = { 1008: true, 4401: true, 4403: true };

/**
 * 解码一个服务端帧：先校验判别字段，帧本身即房间自己的快照
 * （每个消费者都通过权威字段读取它）。
 * 未知或格式错误的帧会被丢弃，绝不猜测其含义。
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  const { type } = value;
  if (type === 'state' || type === 'error' || type === 'pong') return value as ServerMessage;
  return null;
}

/** 将关闭码映射到房间视图会做出反应的那一种情形。 */
export function closeInfo(code: number, reason: string): CloseInfo {
  return {
    code,
    reason,
    authExpired: AUTH_CLOSE_CODES[code] === true || code === WS_CLOSE.sessionExpired,
    replaced: code === WS_CLOSE.replaced,
    roomClosed: code === WS_CLOSE.closed,
    protocolMismatch: code === WS_CLOSE.protocolMismatch,
    inputOverload: code === WS_CLOSE.inputOverload,
  };
}

/** 当前页面为何无法在这个 Socket 上继续与该服务端通信。 */
export type Diagnosis = 'ok' | 'auth' | 'room' | 'protocol';

/**
 * 携带服务端所需协议的 HTTP 409 是一条「需要刷新」的判定，
 * 也包括代理或陈旧请求漏掉本页面当前版本请求头的情况。
 * 初始路由加载与关闭后诊断共用该判定，
 * 使两个界面都能到达同一个终态的「刷新页面」状态。
 */
export function isProtocolRejection(error: unknown): boolean {
  if (!(error instanceof DetailedError)) return false;
  if (error.statusCode !== 409) return false;
  const detail: unknown = error.detail;
  if (!detail || typeof detail !== 'object' || !('data' in detail)) return false;
  const body: unknown = detail.data;
  if (!body || typeof body !== 'object' || !('protocolVersion' in body)) return false;
  return typeof body.protocolVersion === 'string' && body.protocolVersion.length > 0;
}
