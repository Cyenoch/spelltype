/**
 * 测试用例直接调用的公开 HTTP 接口 —— 与客户端所使用的端点完全相同 ——
 * 以及从中读取的有效载荷规范：查看者自身身份、已渲染排行榜用于索引玩家的行，以及协议所携带的准确率数值。
 *
 * 游戏接口位于稳定的 `/api` 根路径下，并且服务端要求在每一个接口上都携带当前的传输协议头；
 * 辅助函数会自动发送 `X-Spelltype-Protocol`。
 * 需要证明过时或缺失协议会被拒绝的测试，可以通过 `apiJson` 的 `headers` 显式覆盖或省略该请求头 ——
 * 辅助函数绝不会静默修复预期应当失败的请求。
 */
import type { BrowserContext } from '@playwright/test';
import { WS_PROTOCOL } from '../../shared/protocol';
import { runtime } from './runtime';

/**
 * 每个请求默认使用应用自身的 origin（服务端状态变更的同源闸门严格要求该 origin），
 * 并且每个游戏路径都携带当前的协议请求头。
 */
export async function apiJson<T>(
  context: BrowserContext,
  url: string,
  init?: {
    method?: string;
    data?: unknown;
    origin?: string;
    /**
     * 不区分大小写地与默认值（`X-Spelltype-Protocol`、`Origin`）合并。
     * 若值为 `undefined`，则从请求中彻底移除该请求头 —— 这是显式省略协议头的方式；
     * 而空字符串则会发送带空值的请求头。
     */
    headers?: Record<string, string | undefined>;
  },
): Promise<{ status: number; body: T }> {
  const absolute = /^https?:/.test(url) ? url : new URL(url, runtime().appUrl).toString();
  const headers: Record<string, string> = {
    // 应用会拒绝没有相同主机、相同协议 Origin 的状态变更请求。
    origin: init?.origin ?? new URL(absolute).origin,
  };
  if (/^\/api\/(rooms|match)\b/.test(new URL(absolute).pathname)) {
    headers['x-spelltype-protocol'] = WS_PROTOCOL;
  }
  for (const [name, value] of Object.entries(init?.headers ?? {})) {
    if (value === undefined) delete headers[name.toLowerCase()];
    else headers[name.toLowerCase()] = value;
  }
  const response = await context.request.fetch(absolute, {
    method: init?.method ?? 'GET',
    data: init?.data,
    headers,
    failOnStatusCode: false,
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : null) as T };
}

/** 针对稳定 `/api` 根路径调用的游戏 API 路径（`/rooms/…`、`/match`）。 */
export async function gameJson<T>(
  context: BrowserContext,
  gamePath: string,
  init?: Parameters<typeof apiJson>[2],
): Promise<{ status: number; body: T }> {
  return apiJson<T>(context, `/api${gamePath}`, init);
}

/** 玩家身份：显示名称加上账号 ID，适配 DOM 所汇报的任一形式。 */
export interface Identity {
  username: string;
  userId: string;
}

export async function selfIdentity(context: BrowserContext): Promise<Identity> {
  const response = await context.request.get('/api/session');
  const body = (await response.json()) as { user: { id: string; username: string } | null };
  if (!body.user) throw new Error('no authenticated user in this context');
  return { username: body.user.username, userId: body.user.id };
}

/** 无论 DOM 按 ID、名称还是标签文本索引玩家，都能匹配到渲染的对应行。 */
export function rowFor<T extends { user: string; text?: string }>(
  rows: T[],
  identity: Identity,
): T | undefined {
  return rows.find(
    (row) =>
      row.user === identity.userId ||
      row.user === identity.username ||
      (row.text ?? '').includes(identity.username),
  );
}

/**
 * 将准确率数值规范化为百分比：协议传输一个数字，可能是 0–1 的比例或已经是百分比数字。
 */
export function accuracyPercent(value: number | string): number {
  const numeric = typeof value === 'number' ? value : Number(value.replace(/[^\d.]/g, ''));
  return numeric <= 1 ? numeric * 100 : numeric;
}
