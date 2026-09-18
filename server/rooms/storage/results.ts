import { results } from '../../db/schema';
import type { ResultInsert } from '../../db/schema';
import type { RoomQuery } from './query';

/**
 * Writes one history row per seat in the caller's transaction — the same
 * transaction that closes the match. `(match_id, user_id)` is the idempotency
 * key, so a retried settle — a rematch replay of the same match id, a second
 * caller racing the deadline — can never store a second row or overwrite the
 * first. There is no outbox and no `saved` flag: committed means saved.
 */
export async function insertResults(db: RoomQuery, rows: readonly ResultInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(results)
    .values([...rows])
    .onConflictDoNothing();
}
