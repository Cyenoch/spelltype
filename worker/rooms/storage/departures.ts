import type { SqlStore } from '../../sql';
import type { DepartureRow } from './schema';

/**
 * Durable record of one account's explicit manual departure from this room.
 *
 * It answers exactly two questions and no more: "has this account already left
 * here?" (idempotent leave replies) and "did this account abandon *this* match?"
 * (readmission and matchmaking entitlement). A pre-match departure carries no
 * match id, and an earlier match's departure no longer names the current one —
 * neither can bar a seat, so the record never outlives the match it belongs to.
 */

export function recordDeparture(
  sql: SqlStore,
  departure: { userId: string; matchId: string | null; now: number },
): void {
  sql.exec(
    `INSERT INTO departures (user_id, match_id, departed_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET match_id = excluded.match_id, departed_at = excluded.departed_at`,
    departure.userId,
    departure.matchId,
    departure.now,
  );
}

export function getDeparture(sql: SqlStore, userId: string): DepartureRow | null {
  const rows = sql
    .exec<DepartureRow>('SELECT * FROM departures WHERE user_id = ?', userId)
    .toArray();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * True when this account explicitly abandoned the given match. A departure from
 * before the match existed (`match_id` null on either side) or from an earlier
 * match is never a bar.
 */
export function abandonedMatch(sql: SqlStore, userId: string, matchId: string | null): boolean {
  if (matchId === null) return false;
  const row = getDeparture(sql, userId);
  return row !== null && row.match_id === matchId;
}
