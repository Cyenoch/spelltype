import { queryOptions, useQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { DetailedError, parseResponse } from 'hono/client';
import type { ReleaseCode, ReleaseInfo } from '../../shared/release';
import { client } from './client';
import { RELEASE_ID } from './release-id';

const RELEASE_CODES: readonly ReleaseCode[] = [
  'release:update_required',
  'release:room_retired',
  'release:unavailable',
];

/**
 * The deployment's release pointer. The stable API is the one authority for
 * "which build is active right now"; this page reads it periodically so the
 * shell can tell a player — honestly and without ever reloading on its own —
 * that a newer release is live.
 */
export const releaseOptions = queryOptions({
  queryKey: ['release'],
  queryFn: ({ signal }) => parseResponse(client.api.release.$get({}, { init: { signal } })),
  staleTime: 10_000,
  refetchInterval: 15_000,
  retry: false,
});

/**
 * Reads the release code out of a versioned API rejection (`{ code, error,
 * activeReleaseId }`), so callers can branch on the server's semantic verdict
 * instead of guessing from status numbers.
 */
export function releaseCodeOf(error: unknown): ReleaseCode | null {
  if (!(error instanceof DetailedError)) return null;
  const body: unknown = error.detail?.data;
  if (!body || typeof body !== 'object' || !('code' in body)) return null;
  const code: unknown = body.code;
  return typeof code === 'string' && RELEASE_CODES.includes(code as ReleaseCode)
    ? (code as ReleaseCode)
    : null;
}

export interface ReleaseService {
  /** The deployment's active release, once the first lookup answered. */
  info(): ReleaseInfo | undefined;
  /** The last lookup's failure; a transient outage means "unknown", never "outdated". */
  error(): unknown;
  /** True when this bundle is not the active release and the player should update. */
  updateRequired(): boolean;
  refresh(): Promise<void>;
  /** A lazy asset of this bundle failed to load (typically after a deployment). */
  assetFailed(): boolean;
  markAssetFailed(): void;
}

/** Creates the one release service for the application. Call in component scope. */
export function createReleaseService(): ReleaseService {
  const query = useQuery(() => releaseOptions);
  // Background metadata belongs to the application, not a route's Suspense
  // boundary: polling must not detach a live room or its focused input.
  const info = createMemo(() => query.data);
  const [assetFailed, setAssetFailed] = createSignal(false);

  // A lazy chunk that vanished (a deployment replaced this build) is the one
  // browser error that means "this bundle is aging out": refresh the pointer so
  // the shell can explain it. The service itself never reloads the page.
  const onPreloadError = (): void => {
    setAssetFailed(true);
    void query.refetch();
  };
  onMount(() => {
    window.addEventListener('vite:preloadError', onPreloadError);
    onCleanup(() => window.removeEventListener('vite:preloadError', onPreloadError));
  });

  return {
    info,
    error: () => query.error,
    updateRequired: () => {
      const current = info();
      return current !== undefined && current.activeReleaseId !== RELEASE_ID;
    },
    refresh: () => query.refetch().then(() => undefined),
    assetFailed,
    markAssetFailed: () => setAssetFailed(true),
  };
}
