import type { ResultRow } from './schema';
import type { SqlStore } from '../../sql';

/**
 * Queues one history row per seat. `(match_id, user_id)` is the idempotency key,
 * so re-queueing a settled match — a retried write, a rematch replay of the same
 * match id — can never store a second row or overwrite the first.
 */
export function queueResults(sql: SqlStore, rows: readonly Omit<ResultRow, 'saved'>[]): void {
  for (const row of rows) {
    sql.exec(
      `INSERT INTO match_results (
        match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms,
        rank, cpm, accuracy, created_at, saved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(match_id, user_id) DO NOTHING`,
      row.match_id,
      row.user_id,
      row.theme,
      row.damage_dealt,
      row.hp_remaining,
      row.spells_cast,
      row.correct_chars,
      row.duration_ms,
      row.rank,
      row.cpm,
      row.accuracy,
      row.created_at,
    );
  }
}

export function listUnsavedResults(sql: SqlStore): ResultRow[] {
  return sql
    .exec<ResultRow>('SELECT * FROM match_results WHERE saved = 0 ORDER BY created_at')
    .toArray();
}

export function countUnsavedResults(sql: SqlStore): number {
  return sql
    .exec<{ total: number }>('SELECT COUNT(*) AS total FROM match_results WHERE saved = 0')
    .one().total;
}

export function markResultsSaved(
  sql: SqlStore,
  rows: readonly { match_id: string; user_id: string }[],
): void {
  for (const row of rows) {
    sql.exec(
      'UPDATE match_results SET saved = 1 WHERE match_id = ? AND user_id = ?',
      row.match_id,
      row.user_id,
    );
  }
}
