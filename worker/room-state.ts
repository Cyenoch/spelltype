import { COMBAT_EVENT_RING_SIZE, INITIAL_HEALTH } from '../shared/protocol';
import type { CombatEvent, Difficulty, EndReason, Persistence, Phase, ReservationState } from '../shared/protocol';

export type RoomMode = 'private' | 'quick';

export type RoomRow = {
  singleton: number;
  id: string;
  host_id: string;
  mode: RoomMode;
  theme: string;
  difficulty: Difficulty;
  phase: Phase;
  /** Opening countdown end, then the single combat end; `0` in phases with no clock. */
  deadline: number;
  /** When the combat phase began, or `null` before it did. */
  started_at: number | null;
  ended_at: number | null;
  end_reason: EndReason | null;
  match_id: string | null;
  /** The match's generated, ordered spell book, shared by every seat. */
  spell_book: string | null;
  /** Bounded recent-damage ring, oldest first, as JSON. */
  events_json: string;
  /** Sequence of the newest event in the ring; `(match_id, seq)` is what clients dedupe on. */
  event_seq: number;
  error: string | null;
  generation_token: string | null;
  generation_claim: string | null;
  generation_seq: number;
  reservation_state: ReservationState;
  reservation_expires_at: number | null;
  locked: number;
  persistence: Persistence;
  persist_attempts: number;
  persist_retry_at: number | null;
  schema_version: number;
  created_at: number;
  updated_at: number;
};

export type PlayerRow = {
  user_id: string;
  username: string;
  slot: number;
  joined_at: number;
  slot_expires_at: number | null;
  conn_id: string | null;
  /** 1 once the account actually connected; reserved invitees stay 0. */
  seated: number;
  ready: number;
  /** Longest accepted prefix of this player's current spell. */
  progress: number;
  /** Private, monotonic, zero-based cursor into the shared spell book. */
  spell_index: number;
  spells_cast: number;
  hp: number;
  max_hp: number;
  damage_dealt: number;
  /** Confirmed characters of completed spells; the live prefix is not included. */
  correct_chars: number;
  attempt_total: number;
  error_total: number;
  cpm: number;
  last_input: string;
  eliminated_at: number | null;
};

export type ResultRow = {
  match_id: string;
  user_id: string;
  theme: string;
  damage_dealt: number;
  hp_remaining: number;
  spells_cast: number;
  correct_chars: number;
  duration_ms: number;
  rank: number;
  cpm: number;
  /** `null` only when the seat never produced a counted keystroke. */
  accuracy: number | null;
  created_at: number;
  saved: number;
};

type RoomPatch = Partial<Omit<RoomRow, 'singleton' | 'id' | 'created_at' | 'updated_at'>>;
type PlayerPatch = Partial<Omit<PlayerRow, 'user_id' | 'username' | 'joined_at'>>;

const ROOM_COLUMNS = new Set<string>([
  'host_id',
  'phase',
  'deadline',
  'started_at',
  'ended_at',
  'end_reason',
  'match_id',
  'spell_book',
  'events_json',
  'event_seq',
  'error',
  'generation_token',
  'generation_claim',
  'generation_seq',
  'reservation_state',
  'reservation_expires_at',
  'locked',
  'persistence',
  'persist_attempts',
  'persist_retry_at',
]);

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
]);

/**
 * Layout version of the two live-state tables. Everything before version 2 is
 * the retired five-round game, which has no continuous-combat columns at all.
 */
export const SCHEMA_VERSION = 2;

const ROOM_COLUMNS_DDL = `
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  theme TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  phase TEXT NOT NULL,
  deadline INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  match_id TEXT,
  spell_book TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',
  event_seq INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  generation_token TEXT,
  generation_claim TEXT,
  generation_seq INTEGER NOT NULL DEFAULT 0,
  reservation_state TEXT NOT NULL DEFAULT 'none',
  reservation_expires_at INTEGER,
  locked INTEGER NOT NULL DEFAULT 0,
  persistence TEXT NOT NULL DEFAULT 'idle',
  persist_attempts INTEGER NOT NULL DEFAULT 0,
  persist_retry_at INTEGER,
  schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL`;

const PLAYER_COLUMNS_DDL = `
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  slot INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  slot_expires_at INTEGER,
  conn_id TEXT,
  seated INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  spell_index INTEGER NOT NULL DEFAULT 0,
  spells_cast INTEGER NOT NULL DEFAULT 0,
  hp INTEGER NOT NULL DEFAULT ${INITIAL_HEALTH},
  max_hp INTEGER NOT NULL DEFAULT ${INITIAL_HEALTH},
  damage_dealt INTEGER NOT NULL DEFAULT 0,
  correct_chars INTEGER NOT NULL DEFAULT 0,
  attempt_total INTEGER NOT NULL DEFAULT 0,
  error_total INTEGER NOT NULL DEFAULT 0,
  cpm INTEGER NOT NULL DEFAULT 0,
  last_input TEXT NOT NULL DEFAULT '',
  eliminated_at INTEGER`;

const ROOM_SCHEMA = `CREATE TABLE IF NOT EXISTS room (${ROOM_COLUMNS_DDL})`;
const PLAYERS_SCHEMA = `CREATE TABLE IF NOT EXISTS players (${PLAYER_COLUMNS_DDL})`;

const RESULTS_SCHEMA = `CREATE TABLE IF NOT EXISTS match_results (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  damage_dealt INTEGER NOT NULL,
  hp_remaining INTEGER NOT NULL,
  spells_cast INTEGER NOT NULL,
  correct_chars INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  cpm INTEGER NOT NULL,
  accuracy REAL,
  created_at INTEGER NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, user_id)
)`;

/** Column names of a table, or `null` when the table does not exist yet. */
function tableColumns(sql: SqlStorage, table: string): Set<string> | null {
  const rows = sql.exec<{ name: string }>(`PRAGMA table_info('${table}')`).toArray();
  return rows.length === 0 ? null : new Set(rows.map((row) => row.name));
}

/**
 * Synchronous schema setup, run once per instance under blockConcurrencyWhile.
 *
 * A database that predates this layout is discarded outright: the live room is
 * authoritative match state, not an archive, so the round-era room, its seats,
 * its round scratch table and any result row still queued under the retired
 * shape are dropped and recreated empty. There is no legacy mode, no conversion
 * and no legacy result variant left behind; accounts and sessions live in D1 and
 * are untouched. Detection is by marker column, so this runs once per database:
 * afterwards it is a sequence of `CREATE TABLE IF NOT EXISTS` no-ops, and a
 * database already in this layout keeps its live room and queued result rows.
 */
export function migrate(sql: SqlStorage): void {
  const roomColumns = tableColumns(sql, 'room');
  const playerColumns = tableColumns(sql, 'players');
  const resultColumns = tableColumns(sql, 'match_results');
  const roundRoom = roomColumns !== null && !roomColumns.has('schema_version');
  const roundPlayers = playerColumns !== null && !playerColumns.has('eliminated_at');
  const roundResults = resultColumns !== null && (resultColumns.has('score') || resultColumns.has('format'));

  if (roundRoom) sql.exec('DROP TABLE IF EXISTS room');
  if (roundPlayers) sql.exec('DROP TABLE IF EXISTS players');
  if (roundRoom || roundPlayers) sql.exec('DROP TABLE IF EXISTS round_stats');
  if (roundResults) sql.exec('DROP TABLE IF EXISTS match_results');

  sql.exec(ROOM_SCHEMA);
  sql.exec(PLAYERS_SCHEMA);
  sql.exec(RESULTS_SCHEMA);
}

export function insertRoom(
  sql: SqlStorage,
  room: {
    id: string;
    hostId: string;
    mode: RoomMode;
    theme: string;
    difficulty: Difficulty;
    reservationState: ReservationState;
    reservationExpiresAt: number | null;
    now: number;
  },
): void {
  sql.exec(
    `INSERT INTO room (
      singleton, id, host_id, mode, theme, difficulty, phase, deadline, started_at, ended_at, end_reason,
      match_id, spell_book, events_json, event_seq, error, generation_token, generation_claim, generation_seq,
      reservation_state, reservation_expires_at, locked, persistence, persist_attempts, persist_retry_at,
      schema_version, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, 'lobby', 0, NULL, NULL, NULL, NULL, NULL, '[]', 0, NULL, NULL, NULL, 0,
      ?, ?, 0, 'idle', 0, NULL, ${SCHEMA_VERSION}, ?, ?)`,
    room.id,
    room.hostId,
    room.mode,
    room.theme,
    room.difficulty,
    room.reservationState,
    room.reservationExpiresAt,
    room.now,
    room.now,
  );
}

export function getRoom(sql: SqlStorage): RoomRow | null {
  const rows = sql.exec<RoomRow>('SELECT * FROM room WHERE singleton = 1').toArray();
  return rows.length > 0 ? rows[0] : null;
}

export function updateRoom(sql: SqlStorage, patch: RoomPatch): void {
  const keys = Object.keys(patch).filter((key) => ROOM_COLUMNS.has(key));
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => (patch as Record<string, string | number | null>)[key] ?? null);
  sql.exec(`UPDATE room SET ${assignments}, updated_at = ? WHERE singleton = 1`, ...values, Date.now());
}

export function listPlayers(sql: SqlStorage): PlayerRow[] {
  return sql.exec<PlayerRow>('SELECT * FROM players ORDER BY slot').toArray();
}

export function getPlayer(sql: SqlStorage, userId: string): PlayerRow | null {
  const rows = sql.exec<PlayerRow>('SELECT * FROM players WHERE user_id = ?', userId).toArray();
  return rows.length > 0 ? rows[0] : null;
}

export function countPlayers(sql: SqlStorage): number {
  return sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM players').one().total;
}

function nextFreeSlot(sql: SqlStorage): number | null {
  const used = new Set(sql.exec<{ slot: number }>('SELECT slot FROM players ORDER BY slot').toArray().map((row) => row.slot));
  for (let slot = 0; slot < 4; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

/** Creates a seat. Returns the seat, or null when all four slots are taken. */
export function insertPlayer(
  sql: SqlStorage,
  player: { userId: string; username: string; slotExpiresAt: number | null; now: number },
): PlayerRow | null {
  const slot = nextFreeSlot(sql);
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

export function updatePlayer(sql: SqlStorage, userId: string, patch: PlayerPatch): void {
  const keys = Object.keys(patch).filter((key) => PLAYER_COLUMNS.has(key));
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => (patch as Record<string, string | number | null>)[key] ?? null);
  sql.exec(`UPDATE players SET ${assignments} WHERE user_id = ?`, ...values, userId);
}

export function deletePlayer(sql: SqlStorage, userId: string): void {
  sql.exec('DELETE FROM players WHERE user_id = ?', userId);
}

export function deleteAllPlayers(sql: SqlStorage): void {
  sql.exec('DELETE FROM players');
}

/** Releases seats that were reserved for a match but never used. */
export function deleteReservedSeats(sql: SqlStorage): void {
  sql.exec('DELETE FROM players WHERE seated = 0');
}

/**
 * Re-arms seat expiry when the room is back in an open lobby: seats whose player
 * is not connected now expire, connected seats do not. Without this a seat that
 * was held through a finished match (expiry cleared while the roster was locked)
 * would block the next start forever.
 */
export function armLobbySeatExpiry(sql: SqlStorage, connectedIds: readonly string[], expiresAt: number): void {
  if (connectedIds.length === 0) {
    sql.exec('UPDATE players SET slot_expires_at = ?', expiresAt);
    return;
  }
  const placeholders = connectedIds.map(() => '?').join(', ');
  sql.exec(`UPDATE players SET slot_expires_at = ? WHERE user_id NOT IN (${placeholders})`, expiresAt, ...connectedIds);
  sql.exec(`UPDATE players SET slot_expires_at = NULL WHERE user_id IN (${placeholders})`, ...connectedIds);
}

export function expireSeats(sql: SqlStorage, now: number): number {
  return sql.exec('DELETE FROM players WHERE slot_expires_at IS NOT NULL AND slot_expires_at <= ?', now).rowsWritten;
}

/**
 * Puts every seat back to a fresh pre-match state: full health, first spell,
 * empty draft and zero aggregates. Called when a match starts, so a previous
 * match's numbers can never leak into the next one.
 */
export function resetPlayersForMatch(sql: SqlStorage): void {
  sql.exec(
    `UPDATE players SET progress = 0, spell_index = 0, spells_cast = 0, hp = ${INITIAL_HEALTH},
      max_hp = ${INITIAL_HEALTH}, damage_dealt = 0, correct_chars = 0, attempt_total = 0, error_total = 0,
      cpm = 0, last_input = '', eliminated_at = NULL`,
  );
}

/** Clears readiness for a fresh lobby; a failed generation keeps it. */
export function clearReady(sql: SqlStorage): void {
  sql.exec('UPDATE players SET ready = 0');
}

/** The most recent damage events of the current match, oldest first. */
export function readEvents(room: RoomRow): CombatEvent[] {
  if (!room.events_json) return [];
  try {
    const parsed: unknown = JSON.parse(room.events_json);
    return Array.isArray(parsed) ? (parsed as CombatEvent[]) : [];
  } catch (error) {
    console.error('[room] unreadable event ring', room.id, error instanceof Error ? error.name : typeof error);
    return [];
  }
}

/**
 * Appends one damage event to the bounded ring and advances the match's event
 * sequence. The ring is trimmed by count, so a long match never grows the row.
 */
export function appendEvent(sql: SqlStorage, event: CombatEvent): void {
  const room = getRoom(sql);
  if (!room) return;
  const events = readEvents(room);
  events.push(event);
  const ring = events.length > COMBAT_EVENT_RING_SIZE ? events.slice(events.length - COMBAT_EVENT_RING_SIZE) : events;
  updateRoom(sql, { events_json: JSON.stringify(ring), event_seq: event.seq });
}

/**
 * Queues one history row per seat. `(match_id, user_id)` is the idempotency key,
 * so re-queueing a settled match — a retried write, a rematch replay of the same
 * match id — can never store a second row or overwrite the first.
 */
export function queueResults(sql: SqlStorage, rows: readonly Omit<ResultRow, 'saved'>[]): void {
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

export function listUnsavedResults(sql: SqlStorage): ResultRow[] {
  return sql.exec<ResultRow>('SELECT * FROM match_results WHERE saved = 0 ORDER BY created_at').toArray();
}

export function countUnsavedResults(sql: SqlStorage): number {
  return sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM match_results WHERE saved = 0').one().total;
}

export function markResultsSaved(sql: SqlStorage, rows: readonly { match_id: string; user_id: string }[]): void {
  for (const row of rows) {
    sql.exec('UPDATE match_results SET saved = 1 WHERE match_id = ? AND user_id = ?', row.match_id, row.user_id);
  }
}
