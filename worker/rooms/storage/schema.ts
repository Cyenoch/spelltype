import { INITIAL_HEALTH } from '../../../shared/protocol';
import { MATCH_ACTIVE } from '../rules';
import type {
  Difficulty,
  EndReason,
  Persistence,
  Phase,
  ReservationState,
  RoomMode,
} from '../../../shared/protocol';
import type { SqlStore } from '../../sql';

/** One durable room, the live match's own state. */
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
  /** The match's immutable input-time policy, locked at start; lobby and pre-policy rooms keep `null`. */
  input_policy_version: string | null;
  input_policy_mode: 'observe' | 'enforce' | null;
  /** Real milliseconds this match charges per target code point; `null` in unmeasured rooms. */
  input_min_ms_per_code_point: number | null;
  locked: number;
  persistence: Persistence;
  persist_attempts: number;
  persist_retry_at: number | null;
  created_at: number;
  updated_at: number;
};

/** One seat. A reserved seat exists before its account ever connects. */
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
  /** When the current spell became this player's to type; `null` outside a live spell. */
  input_opened_at: number | null;
  /** Earliest instant the current spell's completion may count; derived, never client-supplied. */
  input_not_before: number | null;
  /** Bumped on every authoritative reset of the current spell; stale input carries an older epoch. */
  draft_epoch: number;
  input_reset_reason: 'completion_too_early' | null;
  /** 1 once this spell's first completion has been sampled for the eligibility ratio. */
  input_sampled: number;
  /** Distinct spells this match whose completion arrived before the policy floor. */
  input_gate_hits: number;
  /** Authoritative resets of the current spell caused by a too-early completion. */
  input_recoveries: number;
  /** Smallest first-completion eligibility ratio seen this match; `null` until one is sampled. */
  input_min_completion_ratio: number | null;
  /** Sockets this match lost to the per-connection input-message overload guard. */
  input_overloads: number;
  /** Current-spell completions that counted after at least one recovery of that same spell. */
  input_recovered_completions: number;
  /** Times a player left this match while their recovered spell was still incomplete. */
  input_recovery_departures: number;
};

/** One finished match's row for one account, queued here until D1 accepts it. */
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
  /** Policy stamp frozen when the row was written; `legacy-unmeasured` marks pre-policy history. */
  input_policy_version: string;
  input_policy_mode: 'observe' | 'enforce' | null;
  /** Per-match input-policy summaries; all `null` for history that was never measured. */
  input_gate_hits: number | null;
  input_recoveries: number | null;
  input_overloads: number | null;
  input_recovered_completions: number | null;
  input_recovery_departures: number | null;
  /** Smallest first-completion eligibility ratio in the match; `null` when never sampled. */
  input_min_completion_ratio: number | null;
  created_at: number;
  saved: number;
};

/**
 * One account's explicit manual departure from this room. `match_id` names the
 * match that was abandoned; it is `null` when membership was released before a
 * match existed, which makes the row an idempotency marker only — it never bars
 * rejoining, and a departure whose match id differs from the room's current one
 * is history from an earlier match, equally inert.
 */
export type DepartureRow = {
  user_id: string;
  match_id: string | null;
  departed_at: number;
};

/**
 * The columns the input-time policy adds, as full column definitions so the create-table path and
 * the add-column migration path cannot drift. Names are fixed literals — nothing user-supplied is
 * ever interpolated into DDL.
 */
type PolicyColumn = { name: string; ddl: string };

const ROOM_POLICY_COLUMNS: readonly PolicyColumn[] = [
  { name: 'input_policy_version', ddl: 'input_policy_version TEXT' },
  { name: 'input_policy_mode', ddl: 'input_policy_mode TEXT' },
  { name: 'input_min_ms_per_code_point', ddl: 'input_min_ms_per_code_point INTEGER' },
];

const PLAYER_POLICY_COLUMNS: readonly PolicyColumn[] = [
  { name: 'input_opened_at', ddl: 'input_opened_at INTEGER' },
  { name: 'input_not_before', ddl: 'input_not_before INTEGER' },
  { name: 'draft_epoch', ddl: 'draft_epoch INTEGER NOT NULL DEFAULT 0' },
  { name: 'input_reset_reason', ddl: 'input_reset_reason TEXT' },
  { name: 'input_sampled', ddl: 'input_sampled INTEGER NOT NULL DEFAULT 0' },
  { name: 'input_gate_hits', ddl: 'input_gate_hits INTEGER NOT NULL DEFAULT 0' },
  { name: 'input_recoveries', ddl: 'input_recoveries INTEGER NOT NULL DEFAULT 0' },
  { name: 'input_min_completion_ratio', ddl: 'input_min_completion_ratio REAL' },
  { name: 'input_overloads', ddl: 'input_overloads INTEGER NOT NULL DEFAULT 0' },
  {
    name: 'input_recovered_completions',
    ddl: 'input_recovered_completions INTEGER NOT NULL DEFAULT 0',
  },
  {
    name: 'input_recovery_departures',
    ddl: 'input_recovery_departures INTEGER NOT NULL DEFAULT 0',
  },
];

const RESULTS_POLICY_COLUMNS: readonly PolicyColumn[] = [
  {
    name: 'input_policy_version',
    ddl: "input_policy_version TEXT NOT NULL DEFAULT 'legacy-unmeasured'",
  },
  { name: 'input_policy_mode', ddl: 'input_policy_mode TEXT' },
  { name: 'input_gate_hits', ddl: 'input_gate_hits INTEGER' },
  { name: 'input_recoveries', ddl: 'input_recoveries INTEGER' },
  { name: 'input_overloads', ddl: 'input_overloads INTEGER' },
  { name: 'input_recovered_completions', ddl: 'input_recovered_completions INTEGER' },
  { name: 'input_recovery_departures', ddl: 'input_recovery_departures INTEGER' },
  { name: 'input_min_completion_ratio', ddl: 'input_min_completion_ratio REAL' },
];

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ${ROOM_POLICY_COLUMNS.map((column) => column.ddl).join(',\n  ')}`;

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
  eliminated_at INTEGER,
  ${PLAYER_POLICY_COLUMNS.map((column) => column.ddl).join(',\n  ')}`;

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
  ${RESULTS_POLICY_COLUMNS.map((column) => column.ddl).join(',\n  ')},
  PRIMARY KEY (match_id, user_id)
)`;

const DEPARTURES_SCHEMA = `CREATE TABLE IF NOT EXISTS departures (
  user_id TEXT PRIMARY KEY,
  match_id TEXT,
  departed_at INTEGER NOT NULL
)`;

const VOLLEY_SCHEMA = `CREATE TABLE IF NOT EXISTS combat_volley (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  match_id TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  roster_json TEXT NOT NULL,
  casts_json TEXT NOT NULL
)`;

/**
 * Opens or upgrades the room's own database, once per instance under `blockConcurrencyWhile`; the
 * caller runs it inside one `transactionSync` so an upgrade either lands whole or not at all.
 *
 * One layout exists and it is this one: the live room is authoritative match state, not an archive,
 * so there is nothing to convert, probe or discard, and neither a live room nor a queued result row
 * is ever truncated by opening the database. An account's history lives in D1 and is untouched here.
 * A new database is created with the full layout; a database from an earlier layout keeps every row
 * and gains only the missing policy columns, one `ALTER TABLE ... ADD COLUMN` per table, and its
 * pre-policy result rows come out stamped `legacy-unmeasured` — history that was never measured.
 *
 * A surviving room still generating, counting down or playing was started under the old code and
 * holds no locked policy; measuring it mid-flight would mean inventing a start time for spells
 * already typed. The migration refuses it (`input_policy_drain_required`) instead: rolling back to
 * the draining build lets the old code settle the match, and only then does the new layout enable.
 */
export function createSchema(sql: SqlStore): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS room (${ROOM_COLUMNS_DDL})`);
  sql.exec(`CREATE TABLE IF NOT EXISTS players (${PLAYER_COLUMNS_DDL})`);
  sql.exec(RESULTS_SCHEMA);
  sql.exec(DEPARTURES_SCHEMA);
  sql.exec(VOLLEY_SCHEMA);
  addMissingColumns(sql, 'room', ROOM_POLICY_COLUMNS);
  addMissingColumns(sql, 'players', PLAYER_POLICY_COLUMNS);
  addMissingColumns(sql, 'match_results', RESULTS_POLICY_COLUMNS);
  rejectUnmeasuredActiveRoom(sql);
}

/** Adds only the missing columns; `table` is always a fixed literal from the callsites above. */
function addMissingColumns(sql: SqlStore, table: string, columns: readonly PolicyColumn[]): void {
  const present = new Set(
    sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => row.name),
  );
  for (const column of columns) {
    if (present.has(column.name)) continue;
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
  }
}

/**
 * Refuses to enable the gate under an active match that was never measured. Runs after the columns
 * exist, so the read below cannot fail on an old layout, and inside the caller's transaction: the
 * throw rolls the structural changes back and aborts the instance's startup.
 */
function rejectUnmeasuredActiveRoom(sql: SqlStore): void {
  const room = sql
    .exec<
      Pick<
        RoomRow,
        | 'id'
        | 'phase'
        | 'input_policy_version'
        | 'input_policy_mode'
        | 'input_min_ms_per_code_point'
      >
    >(
      'SELECT id, phase, input_policy_version, input_policy_mode, input_min_ms_per_code_point FROM room WHERE singleton = 1',
    )
    .toArray()[0];
  if (!room) return;
  if (!MATCH_ACTIVE[room.phase]) return;
  if (
    room.input_policy_version !== null &&
    room.input_policy_mode !== null &&
    room.input_min_ms_per_code_point !== null
  )
    return;
  console.error({ roomId: room.id, phase: room.phase, reason: 'input_policy_drain_required' });
  throw new Error('input_policy_drain_required');
}
