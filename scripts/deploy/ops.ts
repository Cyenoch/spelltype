// 远程维护通信传输：位于普通应用监听端口上仅支持 Bearer 鉴权的机器 API
// `/api/ops/maintenance`（无独立管理端口，无 Cookie 鉴权）。
// 专为在自身执行容器替换前后负责排空与恢复的 CI/平台自动化设计——本 API 绝不直接操作容器。
// 令牌仅通过环境变量或配置文件传递给 CLI；绝不通过命令行参数传递，也绝不记录进日志。

import {
  drainStatusSchema,
  maintenanceInfoSchema,
  type DrainStatus,
  type MaintenanceInfo,
} from '../../shared/maintenance';

const REQUEST_TIMEOUT_MS = 10_000;

export class MaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflictError';
  }
}

export class OpsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export interface OpsClient {
  baseUrl: string;
  token: string;
}

function detailFrom(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = payload.error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return '(no detail)';
}

async function opsFetch(client: OpsClient, method: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${client.baseUrl}/api/ops/maintenance`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OpsError(
      0,
      `${client.baseUrl}/api/ops/maintenance unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let payload: unknown;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const detail = detailFrom(payload);
    if (response.status === 409) {
      throw new MaintenanceConflictError(`maintenance CAS conflict: ${detail}`);
    }
    throw new OpsError(response.status, `ops ${method} failed (${response.status}): ${detail}`);
  }
  return payload;
}

/** GET /api/ops/maintenance — 完整的 DrainStatus（计数指标、运行时纪元、就绪状态）。 */
export async function opsDrainStatus(client: OpsClient): Promise<DrainStatus> {
  return drainStatusSchema.parse(await opsFetch(client, 'GET'));
}

/** POST {mode:'draining', expectedRevision} — 持久化 drain CAS 操作。 */
export async function opsDrain(
  client: OpsClient,
  expectedRevision: number,
): Promise<MaintenanceInfo> {
  return maintenanceInfoSchema.parse(
    await opsFetch(client, 'POST', { mode: 'draining', expectedRevision }),
  );
}

/**
 * POST {mode:'open', expectedRevision, expectedRuntimeEpoch} — 服务端
 * 在重新开放准入前，根据其当前的处理器运行时及数据库租约校验运行时纪元。
 */
export async function opsResume(
  client: OpsClient,
  expectedRevision: number,
  expectedRuntimeEpoch: number,
): Promise<MaintenanceInfo> {
  return maintenanceInfoSchema.parse(
    await opsFetch(client, 'POST', {
      mode: 'open',
      expectedRevision,
      expectedRuntimeEpoch,
    }),
  );
}
