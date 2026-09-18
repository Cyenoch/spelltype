import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  Difficulty,
  Element,
  InputPolicyMode,
  EndReason,
  Persistence,
  Phase,
  ReservationState,
  RoomMode,
  Spell,
} from '../../shared/protocol';
import type { ReleaseState } from '../../shared/release';
import { INITIAL_HEALTH } from '../../shared/protocol';

/**
 * The whole long-term database: accounts, sessions, releases, rooms, seats and match tickets.
 *
 * PostgreSQL and development PGlite share this Drizzle schema and generated migrations. Rooms,
 * players and global queue tickets share a database so pairing and seat creation commit together.
 *
 * Conventions:
 * - Property names are snake_case to match the existing domain row vocabulary; table exports are
 *   camelCase.
 * - Every millisecond timestamp and deadline is `bigint(..., { mode: 'number' })` — the same
 *   integer-milliseconds contract the room timers always had, safe in PG because epoch ms fits a
 *   double.
 * - Small state vocabularies (phases, modes, ticket states) are `text` with `CHECK` constraints and
 *   typed in TypeScript, matching how the domain already treated them; no PostgreSQL enum types.
 * - `locked`/`seated`/`ready` keep the historical 0/1 integer convention instead of booleans; the
 *   new `draining` column uses `boolean` because it never had an old shape.
 * - Serialized domain JSON (`spell_book`, `events_json`) stays in `text` columns; no second
 *   database or outbox exists to emulate the old object storage.
 */

/** Millisecond epoch column: the domain's one time unit. */
const ms = (name: string) => bigint(name, { mode: 'number' });

export type MatchTicketState = 'waiting' | 'matched';

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  username_key: text('username_key').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: ms('created_at').notNull(),
});

/** Only the digest of a session token is stored, never the token itself. */
export const sessions = pgTable(
  'sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => accounts.id),
    expires_at: ms('expires_at').notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.user_id)],
);

export const releaseVersions = pgTable(
  'release_versions',
  {
    id: text('id').primaryKey(),
    state: text('state').$type<ReleaseState>().notNull(),
    artifact_digest: text('artifact_digest').notNull(),
    /** The (single) deploy operation this version currently participates in. */
    operation_id: text('operation_id').notNull(),
    /** Bumped on every activation/reactivation so stale proofs cannot admit old rooms. */
    admission_epoch: integer('admission_epoch').notNull().default(0),
    runtime_id: text('runtime_id'),
    runtime_epoch: integer('runtime_epoch').notNull().default(0),
    lease_until: ms('lease_until'),
    checked_epoch: integer('checked_epoch'),
    created_at: ms('created_at').notNull(),
    updated_at: ms('updated_at').notNull(),
    retired_at: ms('retired_at'),
  },
  (t) => [
    check('release_versions_id_hex', sql`${t.id} ~ '^[0-9a-f]{32}$'`),
    check('release_versions_state', sql`${t.state} in ('staged','active','retiring','retired')`),
  ],
);

/** The singleton admission pointer: which release may create new resources right now. */
export const releaseControl = pgTable(
  'release_control',
  {
    singleton: integer('singleton').primaryKey().default(1),
    active_release_id: text('active_release_id').references(() => releaseVersions.id),
    revision: integer('revision').notNull().default(0),
    updated_at: ms('updated_at').notNull(),
  },
  (t) => [check('release_control_singleton', sql`${t.singleton} = 1`)],
);

/** One room: live match state plus its release registration. */
export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    release_id: text('release_id')
      .notNull()
      .references(() => releaseVersions.id),
    draining: boolean('draining').notNull().default(false),
    host_id: text('host_id').notNull(),
    mode: text('mode').$type<RoomMode>().notNull(),
    theme: text('theme').notNull(),
    difficulty: text('difficulty').$type<Difficulty>().notNull(),
    phase: text('phase').$type<Phase>().notNull(),
    /** Opening countdown end, then the single combat end; `0` in phases with no clock. */
    deadline: ms('deadline').notNull().default(0),
    started_at: ms('started_at'),
    ended_at: ms('ended_at'),
    end_reason: text('end_reason').$type<EndReason>(),
    match_id: text('match_id'),
    /** The match's generated, ordered spell book, shared by every seat. */
    spell_book: text('spell_book'),
    /** Bounded recent-damage ring, oldest first, as JSON. */
    events_json: text('events_json').notNull().default('[]'),
    /** Sequence of the newest event in the ring; `(match_id, seq)` is what clients dedupe on. */
    event_seq: integer('event_seq').notNull().default(0),
    error: text('error'),
    generation_token: text('generation_token'),
    generation_claim: text('generation_claim'),
    generation_seq: integer('generation_seq').notNull().default(0),
    reservation_state: text('reservation_state')
      .$type<ReservationState>()
      .notNull()
      .default('none'),
    reservation_expires_at: ms('reservation_expires_at'),
    input_policy_version: text('input_policy_version'),
    input_policy_mode: text('input_policy_mode').$type<InputPolicyMode>(),
    input_min_ms_per_code_point: integer('input_min_ms_per_code_point'),
    locked: integer('locked').notNull().default(0),
    persistence: text('persistence').$type<Persistence>().notNull().default('idle'),
    persist_attempts: integer('persist_attempts').notNull().default(0),
    persist_retry_at: ms('persist_retry_at'),
    /** Next durable deadline the owning runtime must wake for; recovered at process startup. */
    next_alarm_at: ms('next_alarm_at'),
    created_at: ms('created_at').notNull(),
    updated_at: ms('updated_at').notNull(),
  },
  (t) => [
    check('rooms_id_hex', sql`${t.id} ~ '^[0-9a-f]{24}$'`),
    check('rooms_mode', sql`${t.mode} in ('private','quick')`),
    check('rooms_difficulty', sql`${t.difficulty} = 'hard'`),
    check(
      'rooms_phase',
      sql`${t.phase} in ('lobby','generating','countdown','playing','finished')`,
    ),
    check(
      'rooms_end_reason',
      sql`${t.end_reason} is null or ${t.end_reason} in ('elimination','timeout')`,
    ),
    check(
      'rooms_reservation_state',
      sql`${t.reservation_state} in ('none','reserved','cancelled','expired','locked')`,
    ),
    check('rooms_persistence', sql`${t.persistence} in ('idle','saving','saved','error')`),
    index('rooms_release_id_idx').on(t.release_id),
    index('rooms_next_alarm_idx')
      .on(t.next_alarm_at)
      .where(sql`${t.next_alarm_at} is not null`),
  ],
);

/** One seat. A reserved seat exists before its account ever connects. */
export const players = pgTable(
  'players',
  {
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    username: text('username').notNull(),
    slot: integer('slot').notNull(),
    joined_at: ms('joined_at').notNull(),
    slot_expires_at: ms('slot_expires_at'),
    conn_id: text('conn_id'),
    /** 1 once the account actually connected; reserved invitees stay 0. */
    seated: integer('seated').notNull().default(0),
    ready: integer('ready').notNull().default(0),
    /** Longest accepted prefix of this player's current spell. */
    progress: integer('progress').notNull().default(0),
    /** Private, monotonic, zero-based cursor into the shared spell book. */
    spell_index: integer('spell_index').notNull().default(0),
    spells_cast: integer('spells_cast').notNull().default(0),
    hp: doublePrecision('hp').notNull().default(INITIAL_HEALTH),
    max_hp: integer('max_hp').notNull().default(INITIAL_HEALTH),
    damage_dealt: doublePrecision('damage_dealt').notNull().default(0),
    /** Confirmed characters of completed spells; the live prefix is not included. */
    correct_chars: integer('correct_chars').notNull().default(0),
    attempt_total: integer('attempt_total').notNull().default(0),
    error_total: integer('error_total').notNull().default(0),
    cpm: integer('cpm').notNull().default(0),
    last_input: text('last_input').notNull().default(''),
    eliminated_at: ms('eliminated_at'),
    input_opened_at: ms('input_opened_at'),
    input_not_before: ms('input_not_before'),
    draft_epoch: bigint('draft_epoch', { mode: 'number' }).notNull().default(0),
    input_reset_reason: text('input_reset_reason').$type<'completion_too_early'>(),
    input_sampled: integer('input_sampled').notNull().default(0),
    input_gate_hits: integer('input_gate_hits').notNull().default(0),
    input_recoveries: integer('input_recoveries').notNull().default(0),
    input_min_completion_ratio: doublePrecision('input_min_completion_ratio'),
    input_overloads: integer('input_overloads').notNull().default(0),
    input_recovered_completions: integer('input_recovered_completions').notNull().default(0),
    input_recovery_departures: integer('input_recovery_departures').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.room_id, t.user_id] }),
    uniqueIndex('players_room_slot_key').on(t.room_id, t.slot),
  ],
);

/**
 * One finished match's row for one account, committed atomically with the terminal room state.
 */
export const results = pgTable(
  'results',
  {
    match_id: text('match_id').notNull(),
    user_id: text('user_id').notNull(),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id),
    theme: text('theme').notNull(),
    /** Damage this account dealt to opponents over the match. */
    damage_dealt: doublePrecision('damage_dealt').notNull(),
    /** Health left when the match settled (0 when this account was eliminated). */
    hp_remaining: doublePrecision('hp_remaining').notNull(),
    spells_cast: integer('spells_cast').notNull(),
    correct_chars: integer('correct_chars').notNull(),
    /** Active combat time only, never lobby/generation/countdown. */
    duration_ms: integer('duration_ms').notNull(),
    rank: integer('rank').notNull(),
    cpm: integer('cpm').notNull(),
    /** `null` when the account produced no counted keystroke: there is no honest 0% or 100% value. */
    accuracy: real('accuracy'),
    created_at: ms('created_at').notNull(),
    input_policy_version: text('input_policy_version').notNull().default('legacy-unmeasured'),
    input_policy_mode: text('input_policy_mode').$type<InputPolicyMode>(),
    input_gate_hits: integer('input_gate_hits'),
    input_recoveries: integer('input_recoveries'),
    input_overloads: integer('input_overloads'),
    input_recovered_completions: integer('input_recovered_completions'),
    input_recovery_departures: integer('input_recovery_departures'),
    input_min_completion_ratio: doublePrecision('input_min_completion_ratio'),
  },
  (t) => [
    // The primary key makes a retried write idempotent.
    primaryKey({ columns: [t.match_id, t.user_id] }),
    index('results_user_recent_idx').on(t.user_id, t.created_at.desc()),
  ],
);

/**
 * One account's explicit manual departure from this room. `match_id` names the match that was
 * abandoned; it is `null` when membership was released before a match existed, which makes the row
 * an idempotency marker only.
 */
export const departures = pgTable(
  'departures',
  {
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    match_id: text('match_id'),
    departed_at: ms('departed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.room_id, t.user_id] })],
);

/**
 * Live room seats owned by a session, so revoking the session can also close those sockets. Only
 * the token digest appears here, exactly as in `sessions`; never the token itself.
 */
export const roomSessions = pgTable(
  'room_sessions',
  {
    session_hash: text('session_hash')
      .notNull()
      .references(() => sessions.token_hash, { onDelete: 'cascade' }),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.session_hash, t.room_id] }),
    index('room_sessions_room_id_idx').on(t.room_id),
  ],
);

/**
 * The one shared matchmaking table: an account's single ticket doubles as the global occupancy
 * record, so "does this account already hold a seat somewhere" is a primary-key lookup and pairing
 * plus room initialization can commit in one transaction.
 */
export const matchTickets = pgTable(
  'match_tickets',
  {
    user_id: text('user_id')
      .primaryKey()
      .references(() => accounts.id),
    request_id: text('request_id').notNull().unique(),
    release_id: text('release_id')
      .notNull()
      .references(() => releaseVersions.id),
    username: text('username').notNull(),
    state: text('state').$type<MatchTicketState>().notNull(),
    room_id: text('room_id').references(() => rooms.id),
    expires_at: ms('expires_at').notNull(),
    created_at: ms('created_at').notNull(),
    updated_at: ms('updated_at').notNull(),
  },
  (t) => [
    check('match_tickets_state', sql`${t.state} in ('waiting','matched')`),
    // Release-scoped cleanup scans and per-account TTL refreshes are the hot paths.
    index('match_tickets_release_state_idx').on(t.release_id, t.state),
    index('match_tickets_expires_at_idx').on(t.expires_at),
  ],
);

export interface PendingCast {
  attackerId: string;
  spellIndex: number;
  element: Element;
  power: number;
}

/** Accepted cast intent survives a failed settlement or runtime restart. */
export const combatVolleys = pgTable('combat_volleys', {
  room_id: text('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  match_id: text('match_id').notNull(),
  ends_at: ms('ends_at').notNull(),
  roster: jsonb('roster').$type<string[]>().notNull(),
  casts: jsonb('casts').$type<PendingCast[]>().notNull(),
});

/** One globally shared preset book and its fenced refresh lease. */
export const spellBookCache = pgTable('spell_book_cache', {
  theme: text('theme').primaryKey(),
  book: jsonb('book').$type<Spell[]>(),
  published_at: ms('published_at'),
  token: text('token'),
  lease_expires_at: ms('lease_expires_at'),
});

/** The drizzle schema object every driver instance is bound to. */
export const schema = {
  accounts,
  sessions,
  releaseVersions,
  releaseControl,
  rooms,
  players,
  departures,
  results,
  roomSessions,
  matchTickets,
  combatVolleys,
  spellBookCache,
};

export type DatabaseSchema = typeof schema;

// Row shapes, named for the domain vocabulary the ports carry over from the object storage era.
export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type ReleaseVersionRow = typeof releaseVersions.$inferSelect;
export type ReleaseVersionInsert = typeof releaseVersions.$inferInsert;
export type ReleaseControlRow = typeof releaseControl.$inferSelect;
export type ReleaseControlInsert = typeof releaseControl.$inferInsert;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomInsert = typeof rooms.$inferInsert;
export type PlayerRow = typeof players.$inferSelect;
export type PlayerInsert = typeof players.$inferInsert;
export type ResultRow = typeof results.$inferSelect;
export type ResultInsert = typeof results.$inferInsert;
export type DepartureRow = typeof departures.$inferSelect;
export type DepartureInsert = typeof departures.$inferInsert;
export type RoomSessionRow = typeof roomSessions.$inferSelect;
export type RoomSessionInsert = typeof roomSessions.$inferInsert;
export type TicketRow = typeof matchTickets.$inferSelect;
export type TicketInsert = typeof matchTickets.$inferInsert;
