import { INITIAL_HEALTH } from '../../../shared/protocol';
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

const DEPARTURES_SCHEMA = `CREATE TABLE IF NOT EXISTS departures (
  user_id TEXT PRIMARY KEY,
  match_id TEXT,
  departed_at INTEGER NOT NULL
)`;

/**
 * Opens the room's own database, once per instance under `blockConcurrencyWhile`.
 *
 * One layout exists and it is this one: the live room is authoritative match state, not an archive,
 * so there is nothing to convert, probe or discard, and neither a live room nor a queued result row
 * is ever truncated by opening the database. An account's history lives in D1 and is untouched here.
 * Every statement is additive (`IF NOT EXISTS`), so a database from before the `departures` table
 * gains exactly that one empty table and nothing else about it changes.
 */
export function createSchema(sql: SqlStore): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS room (${ROOM_COLUMNS_DDL})`);
  sql.exec(`CREATE TABLE IF NOT EXISTS players (${PLAYER_COLUMNS_DDL})`);
  sql.exec(RESULTS_SCHEMA);
  sql.exec(DEPARTURES_SCHEMA);
}
