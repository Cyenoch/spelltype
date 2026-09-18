import { INITIAL_HEALTH, MAX_PRIVATE_PLAYERS } from '../../../shared/protocol';
import type { PlayerRow } from './schema';
import type { SqlStore } from '../../sql';

/** Columns a patch may name; a seat's identity and join time are fixed once it is taken. */
const PLAYER_COLUMNS = new Set<string>([
  'slot',
  'slot_expires_at',
  'conn_id',
  'seated',
  'ready',
  'progress',
  'spell_index',
  'spells_cast',
  'hp',
  'max_hp',
  'damage_dealt',
  'correct_chars',
  'attempt_total',
  'error_total',
  'cpm',
  'last_input',
  'eliminated_at',
  'input_opened_at',
  'input_not_before',
  'draft_epoch',
  'input_reset_reason',
  'input_sampled',
  'input_gate_hits',
  'input_recoveries',
  'input_min_completion_ratio',
  'input_overloads',
  'input_recovered_completions',
  'input_recovery_departures',
]);

export type PlayerPatch = Partial<Omit<PlayerRow, 'user_id' | 'username' | 'joined_at'>>;

export function listPlayers(sql: SqlStore): PlayerRow[] {
  return sql.exec<PlayerRow>('SELECT * FROM players ORDER BY slot').toArray();
}

export function getPlayer(sql: SqlStore, userId: string): PlayerRow | null {
  const rows = sql.exec<PlayerRow>('SELECT * FROM players WHERE user_id = ?', userId).toArray();
  return rows.length > 0 ? rows[0] : null;
}

export function countPlayers(sql: SqlStore): number {
  return sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM players').one().total;
}

/** Creates a seat in the lowest free slot. Returns the seat, or null when the table is full. */
export function insertPlayer(
  sql: SqlStore,
  player: { userId: string; username: string; slotExpiresAt: number | null; now: number },
): PlayerRow | null {
  const used = new Set(
    sql
      .exec<{ slot: number }>('SELECT slot FROM players ORDER BY slot')
      .toArray()
      .map((row) => row.slot),
  );
  let slot: number | null = null;
  for (let candidate = 0; candidate < MAX_PRIVATE_PLAYERS; candidate++) {
    if (!used.has(candidate)) {
      slot = candidate;
      break;
    }
  }
  if (slot === null) return null;
  sql.exec(
    'INSERT OR IGNORE INTO players (user_id, username, slot, joined_at, slot_expires_at) VALUES (?, ?, ?, ?, ?)',
    player.userId,
    player.username,
    slot,
    player.now,
    player.slotExpiresAt,
  );
  return getPlayer(sql, player.userId);
}

/** Applies a patch over the known columns only, so a caller can never inject a column. */
export function updatePlayer(sql: SqlStore, userId: string, patch: PlayerPatch): void {
  const keys = Object.keys(patch).filter((key) => PLAYER_COLUMNS.has(key));
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => (patch as Record<string, string | number | null>)[key] ?? null);
  sql.exec(`UPDATE players SET ${assignments} WHERE user_id = ?`, ...values, userId);
}

export function deletePlayer(sql: SqlStore, userId: string): void {
  sql.exec('DELETE FROM players WHERE user_id = ?', userId);
}

export function deleteAllPlayers(sql: SqlStore): void {
  sql.exec('DELETE FROM players');
}

/** Releases seats that were reserved for a match but never used. */
export function deleteReservedSeats(sql: SqlStore): void {
  sql.exec('DELETE FROM players WHERE seated = 0');
}

/**
 * Re-arms seat expiry when the room is back in an open lobby: seats whose player
 * is not connected now expire, connected seats do not. Without this a seat that
 * was held through a finished match (expiry cleared while the roster was locked)
 * would block the next start forever.
 */
export function armLobbySeatExpiry(
  sql: SqlStore,
  connectedIds: readonly string[],
  expiresAt: number,
): void {
  if (connectedIds.length === 0) {
    sql.exec('UPDATE players SET slot_expires_at = ?', expiresAt);
    return;
  }
  const placeholders = connectedIds.map(() => '?').join(', ');
  sql.exec(
    `UPDATE players SET slot_expires_at = ? WHERE user_id NOT IN (${placeholders})`,
    expiresAt,
    ...connectedIds,
  );
  sql.exec(
    `UPDATE players SET slot_expires_at = NULL WHERE user_id IN (${placeholders})`,
    ...connectedIds,
  );
}

export function expireSeats(sql: SqlStore, now: number): number {
  return sql.exec(
    'DELETE FROM players WHERE slot_expires_at IS NOT NULL AND slot_expires_at <= ?',
    now,
  ).rowsWritten;
}

/**
 * Puts every seat back to a fresh pre-match state: full health, first spell,
 * empty draft and zero aggregates. Also clears the input gate's per-spell
 * eligibility and every per-match policy summary, so neither a previous match's
 * numbers nor its timing state can leak into the next one. Called when a match
 * starts. The per-spell reset a new spell needs (eligibility, epoch, reason,
 * sample flag) is a combat-time patch, deliberately not part of this.
 */
export function resetPlayersForMatch(sql: SqlStore): void {
  sql.exec(
    `UPDATE players SET progress = 0, spell_index = 0, spells_cast = 0, hp = ${INITIAL_HEALTH},
      max_hp = ${INITIAL_HEALTH}, damage_dealt = 0, correct_chars = 0, attempt_total = 0, error_total = 0,
      cpm = 0, last_input = '', eliminated_at = NULL,
      input_opened_at = NULL, input_not_before = NULL, draft_epoch = 0, input_reset_reason = NULL,
      input_sampled = 0, input_gate_hits = 0, input_recoveries = 0, input_min_completion_ratio = NULL,
      input_overloads = 0, input_recovered_completions = 0, input_recovery_departures = 0`,
  );
}

/** Clears readiness for a fresh lobby; a failed generation keeps it. */
export function clearReady(sql: SqlStore): void {
  sql.exec('UPDATE players SET ready = 0');
}
