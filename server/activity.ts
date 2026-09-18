import { and, count, eq, gt } from 'drizzle-orm';
import type { ActivitySummary } from '../shared/protocol';
import type { QueryDatabase } from './db';
import { matchTickets, rooms } from './db/schema';

/**
 * Public activity counters for the homepage's `GET /api/activity`.
 *
 * One database now holds every room and every ticket, so both counters are straight queries over
 * the domain's own lifecycle rules — the old per-object probes and the expiring discovery index
 * are gone, not emulated:
 *
 * - A duel is ongoing exactly when the room's phase is `playing` and its single combat deadline
 *   has not passed. The clock decides, never the alarm: a match the deadline has already ended
 *   but whose alarm has not caught up yet does not count.
 * - A waiting player is a live, unpaired queue entry whose TTL has not expired. Matched tickets
 *   hold seats, not queue places, so they never count.
 *
 * The result carries no room ids, names, themes or phases; `GET /api/activity` answers 503 rather
 * than fabricating totals when the read fails.
 */
export async function readActivitySummary(database: QueryDatabase): Promise<ActivitySummary> {
  const now = Date.now();
  const [duels] = await database
    .select({ live: count() })
    .from(rooms)
    .where(and(eq(rooms.phase, 'playing'), gt(rooms.deadline, now)));
  const [waiting] = await database
    .select({ live: count() })
    .from(matchTickets)
    .where(and(eq(matchTickets.state, 'waiting'), gt(matchTickets.expires_at, now)));
  return {
    activeDuels: Number(duels?.live ?? 0),
    waitingPlayers: Number(waiting?.live ?? 0),
  };
}
