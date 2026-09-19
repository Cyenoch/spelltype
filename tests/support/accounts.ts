/**
 * The worker shares a database, so closing a browser is not enough to hand over to the next
 * test: disconnected private matches still block retirement, and quick seats still occupy the
 * queue. Observe membership through the harness's database, but release it only through the
 * public cancel/leave endpoints. No database state is deleted or rewritten by cleanup.
 */
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import { expect, request, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { WS_PROTOCOL, type SessionInfo } from '../../shared/protocol';
import { players, rooms } from '../../server/db';
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
  const api = await request.newContext({
    storageState: { cookies, origins: [] },
    extraHTTPHeaders: { 'X-Spelltype-Protocol': WS_PROTOCOL },
  });
  tracked.push({ api, browser: context });
}

/** Releases each account's own seats; an authorization or server refusal is never success. */
export async function cleanupTrackedQueues(): Promise<void> {
  const accounts = tracked.splice(0);
  const failures: unknown[] = [];
  try {
    // Stop polling before cancellation, otherwise a still-open queue could immediately rejoin.
    for (const browser of new Set(accounts.map((account) => account.browser))) {
      await browser.close();
    }
    const appUrl = runtime().appUrl;
    const activeRoom = or(
      inArray(rooms.phase, ['generating', 'countdown', 'playing']),
      and(eq(rooms.reservation_state, 'reserved'), gt(rooms.reservation_expires_at, Date.now())),
    );
    for (const { api } of accounts) {
      try {
        const session = await api.get(new URL('/api/session', appUrl).href);
        if (session.status() !== 200)
          throw new Error(`account cleanup: GET /api/session returned ${session.status()}`);
        const { user } = (await session.json()) as SessionInfo;
        if (!user) continue; // Revoked sessions cannot perform further authenticated operations.

        const cancel = await api.delete(new URL('/api/match', appUrl).href, {
          headers: { origin: appUrl },
        });
        if (cancel.status() !== 200)
          throw new Error(`account cleanup: DELETE /api/match returned ${cancel.status()}`);
        if (typeof (await cancel.json()).cancelled !== 'boolean')
          throw new Error('account cleanup: cancellation response has no boolean result');

        // cancelled:false is truthful for a started match. Leave actual membership — including
        // private rooms with no ticket — through the room's own public leave endpoint.
        const memberships = await testDb()
          .select({ id: rooms.id })
          .from(rooms)
          .innerJoin(players, eq(players.room_id, rooms.id))
          .where(and(eq(players.user_id, user.id), activeRoom));
        for (const room of memberships) {
          const left = await api.post(new URL(`/api/rooms/${room.id}/leave`, appUrl).href, {
            headers: { origin: appUrl },
          });
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
