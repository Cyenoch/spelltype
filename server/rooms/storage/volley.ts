import { eq } from 'drizzle-orm';
import { combatVolleys } from '../../db/schema';
import type { PendingCast } from '../../db/schema';
import type { RoomQuery } from './query';

export type { PendingCast } from '../../db/schema';

/** The one open 100ms combat window of a room: every accepted cast waiting for its batch boundary. */
export interface PendingVolley {
  matchId: string;
  endsAt: number;
  /** The seats the window's damage may land on, frozen at the first cast. */
  roster: string[];
  casts: PendingCast[];
}

/**
 * Reads the room's one open volley, or `null` when no window is open. Only one
 * window can exist per room, so overdue damage is applied before any new input
 * is accepted. Works identically on a plain database and on a transaction.
 */
export async function readVolley(db: RoomQuery, roomId: string): Promise<PendingVolley | null> {
  const rows = await db
    .select()
    .from(combatVolleys)
    .where(eq(combatVolleys.room_id, roomId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { matchId: row.match_id, endsAt: row.ends_at, roster: row.roster, casts: row.casts };
}

/**
 * The caller advances the spell cursor in the same transaction as this durable
 * commitment: either the cast intent and the cursor land together or neither
 * does. A pending window's identity fields are immutable — only the cast list
 * grows — so a late writer can never move an already-accepted batch boundary.
 */
export async function queueCast(
  db: RoomQuery,
  roomId: string,
  volley: PendingVolley,
  cast: PendingCast,
): Promise<void> {
  const casts = [...volley.casts, cast];
  await db
    .insert(combatVolleys)
    .values({
      room_id: roomId,
      match_id: volley.matchId,
      ends_at: volley.endsAt,
      roster: volley.roster,
      casts,
    })
    .onConflictDoUpdate({
      target: combatVolleys.room_id,
      set: { casts },
    });
}

/** Clears the room's volley, in the same transaction that applied its damage. */
export async function clearVolley(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(combatVolleys).where(eq(combatVolleys.room_id, roomId));
}
