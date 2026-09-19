import { queryOptions, useQuery } from '@tanstack/solid-query';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { DetailedError, parseResponse } from 'hono/client';
import type { MaintenanceCode, ServiceStatus } from '../../shared/maintenance';
import { client } from './client';

/**
 * 从 503 API 拒绝响应（`{ code, error }`）中读取维护状态码，
 * 以便调用方根据服务端明确的语义判定（“排空中/draining”或“暂时不可用/temporarily unavailable”）
 * 进行分支处理，而不是根据 HTTP 状态码盲目猜测。
 */
export function maintenanceCodeOf(error: unknown): MaintenanceCode | null {
  if (!(error instanceof DetailedError)) return null;
  const body: unknown = error.detail?.data;
  if (!body || typeof body !== 'object' || !('code' in body)) return null;
  const code: unknown = body.code;
  return code === 'maintenance:draining' || code === 'maintenance:unavailable' ? code : null;
}

/**
 * 部署环境的持久化维护状态。`/api/status` 是判断“当前是否允许开启新对局”的
 * 唯一权威来源；本页面通过轮询该接口，使外层壳组件能够准确提示维护窗口信息，
 * 并在维护结束时立即重新开放入口，全程无需用户手动刷新页面。
 */
export const statusOptions = queryOptions({
  queryKey: ['status'],
  queryFn: ({ signal }) => parseResponse(client.api.status.$get({}, { init: { signal } })),
  staleTime: 10_000,
  refetchInterval: 15_000,
  retry: false,
});

export interface MaintenanceService {
  /** 首次轮询返回后的服务状态。 */
  status(): ServiceStatus | undefined;
  /** 上次轮询的失败原因；偶发的中断意味着“状态未知”，绝不代表“已关闭”。 */
  error(): unknown;
  /** 当服务端持久化拒绝新对局准入（draining 状态）时为 true。 */
  draining(): boolean;
  /** 当上次状态轮询失败（服务状态未知）时为 true。 */
  unavailable(): boolean;
  /**
   * 对所有会开启新对局的操作执行 fail-closed（故障即阻断）：
   * 处于 draining 状态，或状态接口本身不可用时均阻断。已存在的房间绝不受此限制。
   */
  admissionBlocked(): boolean;
  refresh(): Promise<void>;
  /** 当前代码包的懒加载资源加载失败（通常发生在重新部署之后）。 */
  assetFailed(): boolean;
}

/** 创建应用的唯一维护服务实例。须在组件上下文中调用。 */
export function createMaintenanceService(): MaintenanceService {
  const query = useQuery(() => statusOptions);
  const [assetFailed, setAssetFailed] = createSignal(false);

  // 懒加载代码块丢失（因新部署替换了当前构建版本）是浏览器中唯一表示
  // “当前前端包已过时”的错误：捕获并展示该状态，以便外层壳组件提示用户显式刷新。
  // 服务自身绝不主动重载页面——正在进行的对局绝不能被强行中断。
  const onPreloadError = (): void => {
    setAssetFailed(true);
    void query.refetch();
  };
  onMount(() => {
    window.addEventListener('vite:preloadError', onPreloadError);
    onCleanup(() => window.removeEventListener('vite:preloadError', onPreloadError));
  });

  return {
    status: () => query.data,
    error: () => query.error,
    draining: () => query.data?.maintenance.mode === 'draining',
    unavailable: () => query.isError,
    admissionBlocked: () => query.isError || query.data?.maintenance.mode !== 'open',
    refresh: () => query.refetch().then(() => undefined),
    assetFailed,
  };
}
