/**
 * The worker shares a database, so closing a browser is not enough to hand over to the next
 * test: disconnected private matches still block retirement, and quick seats still occupy the
 * queue. Observe membership through the harness's database, but release it only through the
 * public cancel/leave endpoints. No database state is deleted or rewritten by cleanup.
 */
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import { expect, request, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { gameApiBase } from '../../shared/release';
import type { SessionInfo } from '../../shared/protocol';
import { players, releaseControl, rooms } from '../../server/db';
import { testDb } from './db';
import { runtime } from './runtime';

interface TrackedAccount {
  api: APIRequestContext;
  browser: BrowserContext;
}
const tracked: TrackedAccount[] = [];

/** Retains the session cookie even when the spec closes its browser context. */
export async function trackAccountForQueueCleanup(
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const cookies = await context.cookies(baseUrl);
  if (cookies.length === 0)
    throw new Error(`queue cleanup tracking found no session cookie for ${baseUrl}`);
  const api = await request.newContext({ storageState: { cookies, origins: [] } });
  tracked.push({ api, browser: context });
}

/** Releases each account's own seats; an authorization or release mismatch is never success. */
export async function cleanupTrackedQueues(): Promise<void> {
  const accounts = tracked.splice(0);
  const failures: unknown[] = [];
  try {
    // Stop polling before cancellation, otherwise a still-open queue could immediately rejoin.
    for (const browser of new Set(accounts.map((account) => account.browser))) {
      await browser.close();
    }
    const current = runtime();
    const [control] = await testDb().select().from(releaseControl);
    const activeRelease = control?.active_release_id;
    if (!activeRelease) throw new Error('account cleanup found no active release');
    const endpoint = (releaseId: string, path: string) => {
      const origin = current.uiUrls[releaseId];
      if (!origin) throw new Error(`account cleanup has no UI origin for release ${releaseId}`);
      return {
        url: new URL(`${gameApiBase(releaseId)}${path}`, origin).href,
        headers: { 'x-spelltype-release': releaseId, origin },
      };
    };
    const activeRoom = or(
      inArray(rooms.phase, ['generating', 'countdown', 'playing']),
      and(eq(rooms.reservation_state, 'reserved'), gt(rooms.reservation_expires_at, Date.now())),
    );
    for (const { api } of accounts) {
      try {
        const session = await api.get(new URL('/api/session', current.appUrl).href);
        if (session.status() !== 200)
          throw new Error(`account cleanup: GET /api/session returned ${session.status()}`);
        const { user } = (await session.json()) as SessionInfo;
        if (!user) continue; // Revoked sessions cannot perform further authenticated operations.

        const cancelTarget = endpoint(activeRelease, '/match');
        const cancel = await api.delete(cancelTarget.url, { headers: cancelTarget.headers });
        if (cancel.status() !== 200)
          throw new Error(`account cleanup: DELETE /match returned ${cancel.status()}`);
        if (typeof (await cancel.json()).cancelled !== 'boolean')
          throw new Error('account cleanup: cancellation response has no boolean result');

        // cancelled:false is truthful for a started match. Leave actual membership, including
        // private rooms with no ticket, through its owning release rather than the active one.
        const memberships = await testDb()
          .select({ id: rooms.id, releaseId: rooms.release_id })
          .from(rooms)
          .innerJoin(players, eq(players.room_id, rooms.id))
          .where(and(eq(players.user_id, user.id), activeRoom));
        for (const room of memberships) {
          const target = endpoint(room.releaseId, `/rooms/${room.id}/leave`);
          const left = await api.post(target.url, { headers: target.headers });
          if (left.status() !== 200)
            throw new Error(`account cleanup: leave ${room.id} returned ${left.status()}`);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    // A pre-combat forfeit is durable immediately, but generation/countdown completes through
    // the runtime's existing transition. Observe that settlement with the suite's normal limit.
    if (failures.length === 0)
      await expect
        .poll(() => testDb().select({ id: rooms.id }).from(rooms).where(activeRoom))
        .toEqual([]);
  } finally {
    const disposed = await Promise.allSettled(accounts.map(({ api }) => api.dispose()));
    for (const result of disposed) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Account cleanup failed');
}
