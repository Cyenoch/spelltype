import { and, eq } from 'drizzle-orm';
import { departures } from '../../db/schema';
import type { DepartureRow } from '../../db/schema';
import type { RoomQuery } from './query';

/**
 * Durable record of one account's explicit manual departure from this room.
 *
 * It answers exactly two questions and no more: "has this account already left
 * here?" (idempotent leave replies) and "did this account abandon *this* match?"
 * (readmission and matchmaking entitlement). A pre-match departure carries no
 * match id, and an earlier match's departure no longer names the current one —
 * neither can bar a seat, so the record never outlives the match it belongs to.
 */

export async function recordDeparture(
  db: RoomQuery,
  roomId: string,
  departure: { userId: string; matchId: string | null; now: number },
): Promise<void> {
  await db
    .insert(departures)
    .values({
      room_id: roomId,
      user_id: departure.userId,
      match_id: departure.matchId,
      departed_at: departure.now,
    })
    .onConflictDoUpdate({
      target: [departures.room_id, departures.user_id],
      set: { match_id: departure.matchId, departed_at: departure.now },
    });
}

export async function getDeparture(
  db: RoomQuery,
  roomId: string,
  userId: string,
): Promise<DepartureRow | null> {
  const rows = await db
    .select()
    .from(departures)
    .where(and(eq(departures.room_id, roomId), eq(departures.user_id, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * True when this account explicitly abandoned the given match. A departure from
 * before the match existed (`match_id` null on either side) or from an earlier
 * match is never a bar.
 */
export async function abandonedMatch(
  db: RoomQuery,
  roomId: string,
  userId: string,
  matchId: string | null,
): Promise<boolean> {
  if (matchId === null) return false;
  const row = await getDeparture(db, roomId, userId);
  return row !== null && row.match_id === matchId;
}
