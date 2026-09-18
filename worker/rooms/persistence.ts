import type { RoomScope } from './scope';
import { countUnsavedResults, listUnsavedResults, markResultsSaved } from './storage/results';
import { getRoom, updateRoom } from './storage/room';
import { scheduleAlarm } from './timers';

/** Result writes back off up to this delay and keep retrying: an outage may be long. */
const PERSIST_BACKOFF_CAP_MS = 60_000;
/**
 * How long a queued result write may stay in flight before another attempt is
 * allowed. Persisted before the D1 call, so a reset in the middle of a batch is
 * recovered by the alarm instead of leaving `saving` forever.
 */
const PERSIST_LEASE_MS = 30_000;

/**
 * Writes every queued result row with an idempotent upsert (`ON CONFLICT DO
 * NOTHING`, not `INSERT OR IGNORE`: a genuinely malformed row must raise and
 * stay in the retry path instead of being silently dropped), then derives the
 * visible state from what is actually still unsaved. A slower, older batch can
 * therefore never report "saved" for rows a newer batch queued, and a retried
 * write can never count a match twice.
 */
export async function saveResults(scope: RoomScope): Promise<void> {
  const room = getRoom(scope.sql);
  if (!room) return;
  const pending = listUnsavedResults(scope.sql);
  if (pending.length === 0) {
    if (room.persistence !== 'saved')
      updateRoom(scope.sql, { persistence: 'saved', persist_retry_at: null, persist_attempts: 0 });
    return;
  }
  // Lease the attempt durably and arm the alarm *before* the external write:
  // a reset between here and the D1 reply is recovered from the queued rows,
  // and the lease keeps a concurrent attempt from starting meanwhile.
  updateRoom(scope.sql, { persistence: 'saving', persist_retry_at: Date.now() + PERSIST_LEASE_MS });
  await scheduleAlarm(scope);
  let failure: unknown = null;
  try {
    await scope.env.DB.batch(
      pending.map((row) =>
        scope.env.DB.prepare(
          `INSERT INTO results (
            match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms,
            rank, cpm, accuracy, created_at, input_policy_version, input_policy_mode,
            input_gate_hits, input_recoveries, input_min_completion_ratio, input_overloads,
            input_recovered_completions, input_recovery_departures
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(match_id, user_id) DO NOTHING`,
        ).bind(
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
          row.input_policy_version,
          row.input_policy_mode,
          row.input_gate_hits,
          row.input_recoveries,
          row.input_min_completion_ratio,
          row.input_overloads,
          row.input_recovered_completions,
          row.input_recovery_departures,
        ),
      ),
    );
    markResultsSaved(scope.sql, pending);
  } catch (error) {
    failure = error;
  }
  if (countUnsavedResults(scope.sql) === 0) {
    updateRoom(scope.sql, { persistence: 'saved', persist_retry_at: null, persist_attempts: 0 });
  } else {
    // Retries are unbounded with a capped delay: a result that is merely late
    // is recoverable, and the visible state stays `error` until it lands.
    const attempts = room.persist_attempts + 1;
    const retryAt =
      Date.now() + Math.min(PERSIST_BACKOFF_CAP_MS, 2_000 * 2 ** Math.min(attempts, 5));
    updateRoom(scope.sql, {
      persistence: 'error',
      persist_attempts: attempts,
      persist_retry_at: retryAt,
    });
    console.error(
      '[room] result save failed',
      room.id,
      attempts,
      failure instanceof Error ? failure.name : typeof failure,
    );
  }
  // Replace the attempt lease with whatever the outcome actually needs.
  await scheduleAlarm(scope);
}
