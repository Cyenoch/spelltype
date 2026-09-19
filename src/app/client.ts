import { hc } from 'hono/client';
import type { AppType } from '../../server/http/app';
import { WS_PROTOCOL } from '../../shared/protocol';

/**
 * 统一的 API 客户端，基于服务端自身的路由链进行类型推导。
 * 所有路由均位于当前源下的固定 `/api` 前缀之下——包括会话（session）、
 * 个人资料（profile）、活动数据（activity）、状态（status）以及对局相关路由——
 * 从而保证会话 Cookie 随每次请求一并携带，无需维护两套需保持同步的版本化接口。
 * 调用方通过 `parseResponse` 处理请求结果，成功时返回响应体，
 * 失败时抛出 Hono 的 `DetailedError`（通过 `statusCode` 控制流程，通过 `detail.data` 获取服务端的 JSON 错误体）。
 */
export const client = hc<AppType>('/', {
  init: { credentials: 'same-origin' },
  headers: { 'X-Spelltype-Protocol': WS_PROTOCOL },
});
