// 用作部署验证凭据的公开端点探测工具。此处无管理后台监听端口，
// 亦无 Bearer 令牌：运行器所信任的唯一 HTTP 凭据为公开的 /health
// （验证活跃运行时租约与数据库连接，证明构建标识以及恢复准入所需的运行时纪元），
// 以及 /api/status（维护状态指针、协议版本与构建标识）。

import { z } from 'zod';
import { serviceStatusSchema, type ServiceStatus } from '../../shared/maintenance';

const REQUEST_TIMEOUT_MS = 10_000;

// /health 没有共享的业务 Schema（它是部署凭据）；在本地进行模式解析
// 既能保证边界契约的严谨性，又无需人为臆造重复的领域类型。
const runtimeHealthSchema = z.object({
  ok: z.literal(true),
  buildId: z.string().min(1),
  protocolVersion: z.string().min(1),
  runtimeEpoch: z.number(),
});

export interface RuntimeHealth extends z.infer<typeof runtimeHealthSchema> {}

export class ProbeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

interface ProbeTarget {
  appBaseUrl: string;
}

async function getJson(target: ProbeTarget, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${target.appBaseUrl}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProbeError(
      0,
      `${target.appBaseUrl}${path} unreachable (${error instanceof Error ? error.message : String(error)}); is the app container running?`,
    );
  }
  if (!response.ok) {
    throw new ProbeError(response.status, `${path} returned ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeError(response.status, `${path} returned a non-JSON body`);
  }
}

/** 在公开监听端口上请求 GET /api/status（获取维护状态指针及版本标识）。 */
export async function getServiceStatus(target: ProbeTarget): Promise<ServiceStatus> {
  return serviceStatusSchema.parse(await getJson(target, '/api/status'));
}

/**
 * 在公开监听端口上请求 GET /health：仅当活跃运行时租约和数据库均可访问时才返回 200
 * ——维护排空期间亦同。返回的 runtimeEpoch 即为运行器在恢复准入时
 * 传递给维护入口的租约凭据。
 */
export async function getRuntimeHealth(target: ProbeTarget): Promise<RuntimeHealth> {
  return runtimeHealthSchema.parse(await getJson(target, '/health'));
}
