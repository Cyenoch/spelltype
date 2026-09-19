import { queryOptions, useQuery } from '@tanstack/solid-query';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { DetailedError, parseResponse } from 'hono/client';
import type { MaintenanceCode, ServiceStatus } from '../../shared/maintenance';
import { client } from './client';

/**
 * Reads the maintenance code out of a 503 API rejection (`{ code, error }`), so
 * callers can branch on the server's semantic verdict — "draining" or
 * "temporarily unavailable" — instead of guessing from status numbers.
 */
export function maintenanceCodeOf(error: unknown): MaintenanceCode | null {
  if (!(error instanceof DetailedError)) return null;
  const body: unknown = error.detail?.data;
  if (!body || typeof body !== 'object' || !('code' in body)) return null;
  const code: unknown = body.code;
  return code === 'maintenance:draining' || code === 'maintenance:unavailable' ? code : null;
}

/**
 * The deployment's durable maintenance status. `/api/status` is the one
 * authority for "may a new match start right now"; this page polls it so the
 * shell can honestly explain a maintenance window — and flip the entrances
 * back on the moment it ends — without anyone reloading the page.
 */
export const statusOptions = queryOptions({
  queryKey: ['status'],
  queryFn: ({ signal }) => parseResponse(client.api.status.$get({}, { init: { signal } })),
  staleTime: 10_000,
  refetchInterval: 15_000,
  retry: false,
});

export interface MaintenanceService {
  /** The service's status, once the first poll answered. */
  status(): ServiceStatus | undefined;
  /** The last poll's failure; a transient outage means "unknown", never "closed". */
  error(): unknown;
  /** True while the server durably admits no new matches (draining). */
  draining(): boolean;
  /** True when the last status poll failed: the service state is unknown. */
  unavailable(): boolean;
  /**
   * Fail closed for everything that would start a match: draining, or the
   * status itself is unavailable. Existing rooms are never blocked by this.
   */
  admissionBlocked(): boolean;
  refresh(): Promise<void>;
  /** A lazy asset of this bundle failed to load (typically after a deployment). */
  assetFailed(): boolean;
}

/** Creates the one maintenance service for the application. Call in component scope. */
export function createMaintenanceService(): MaintenanceService {
  const query = useQuery(() => statusOptions);
  const [assetFailed, setAssetFailed] = createSignal(false);

  // A lazy chunk that vanished (a deployment replaced this build) is the one
  // browser error that means "this bundle is aging out": surface it so the
  // shell can offer an explicit refresh. The service itself never reloads the
  // page — an active match is never interrupted on its own.
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
