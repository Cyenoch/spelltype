import { sql } from 'drizzle-orm';
import {
  bigint,
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
  AccountRole,
  Difficulty,
  Element,
  InputPolicyMode,
  EndReason,
  OpponentKind,
  Persistence,
  Phase,
  ReservationState,
  RoomMode,
  Spell,
} from '../../shared/protocol';
import type { MaintenanceMode } from '../../shared/maintenance';
import { INITIAL_HEALTH } from '../../shared/protocol';

/**
 * The whole long-term database: WeChat-auth accounts and login state, sessions, rooms, seats and
 * match tickets — plus the one `runtime_control` row that owns maintenance mode and the global
 * runtime lease.
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
 * - `locked`/`seated`/`ready` keep the historical 0/1 integer convention instead of booleans.
 * - Serialized domain JSON (`spell_book`, `events_json`) stays in `text` columns; no second
 *   database or outbox exists to emulate the old object storage.
 */

/** Millisecond epoch column: the domain's one time unit. */
const ms = (name: string) => bigint(name, { mode: 'number' });

export type MatchTicketState = 'waiting' | 'matched';

/**
 * One WeChat identity's account. `username` is the display nickname from the bridge profile and is
 * deliberately non-unique; `wechat_identity` (`union:<unionid>` or `open:<openid>`/`mp:<openid>`)
 * is the one stable, unique credential.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    wechat_identity: text('wechat_identity').notNull().unique(),
    /** Management role (`user` by default; `admin` may use the maintenance tooling). Game-wire data never carries it. */
    role: text('role').$type<AccountRole>().notNull().default('user'),
    created_at: ms('created_at').notNull(),
  },
  (t) => [check('accounts_role', sql`${t.role} in ('user','admin')`)],
);

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

/**
 * One outbound WeChat OAuth attempt. The SHA-256 of the `state` parameter (also stored raw in the
 * `spelltype_wechat_state` cookie) is the single-use key, so a callback only completes when its
 * state was issued here, is unexpired, and the row is deleted in the same transaction. `room_id`
 * carries the optional invite the login started from.
 */
export const wechatLoginAttempts = pgTable('wechat_login_attempts', {
  state_hash: text('state_hash').primaryKey(),
  room_id: text('room_id'),
  expires_at: ms('expires_at').notNull(),
});

/**
 * Bridge relay-token `jti`s already redeemed at the callback. Storing them until the token's own
 * expiry makes a replayed callback token provably single-use even if the login attempt row is
 * already gone.
 */
export const wechatRelayTokens = pgTable('wechat_relay_tokens', {
  jti: text('jti').primaryKey(),
  expires_at: ms('expires_at').notNull(),
});

/**
 * The one global control row: maintenance mode, its CAS revision, and the single runtime
 * ownership lease. Every admission decision, every state transition and every write fence in the
 * game serializes through this row, so it is deliberately tiny — one row, locked in one of two
 * modes (`FOR SHARE` for readers/admission, `FOR UPDATE` for transitions).
 */
export const runtimeControl = pgTable(
  'runtime_control',
  {
    singleton: integer('singleton').primaryKey().default(1),
    mode: text('mode').$type<MaintenanceMode>().notNull(),
    /** CAS token for maintenance transitions; bumped on every committed change. */
    revision: integer('revision').notNull().default(0),
    updated_at: ms('updated_at').notNull(),
    /** The current runtime owner's token; `null` when no runtime holds the lease. */
    runtime_id: text('runtime_id'),
    /** Monotonic ownership generation, bumped on every fresh claim or takeover. */
    runtime_epoch: integer('runtime_epoch').notNull().default(0),
    /** Database-clock deadline after which the lease is considered lapsed. */
    lease_until: ms('lease_until'),
  },
  (t) => [
    check('runtime_control_singleton', sql`${t.singleton} = 1`),
    check('runtime_control_mode', sql`${t.mode} in ('open','draining')`),
  ],
);

/** One room: live match state. Maintenance is global, so rooms carry no flag of their own. */
export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
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
    /** What the non-host seat holds: a human, a replayed recorded ghost, or a generated bot. */
    opponent_kind: text('opponent_kind').$type<OpponentKind>().notNull().default('human'),
    /** The replayed ghost row when `opponent_kind` is `ghost`; `null` for every other room. */
    ghost_id: text('ghost_id'),
    /** Durable ms deadline of the opponent's next scheduled cast; `null` when none is due. */
    opponent_next_at: ms('opponent_next_at'),
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
    check('rooms_opponent_kind', sql`${t.opponent_kind} in ('human','ghost','bot')`),
    check('rooms_difficulty', sql`${t.difficulty} = 'hard'`),
    check(
      'rooms_phase',
      sql`${t.phase} in ('lobby','generating','countdown','playing','finished')`,
    ),
    check(
      'rooms_end_reason',
      sql`${t.end_reason} is null or ${t.end_reason} in ('elimination','timeout','bot_concession','inactivity')`,
    ),
    check(
      'rooms_reservation_state',
      sql`${t.reservation_state} in ('none','reserved','cancelled','expired','locked')`,
    ),
    check('rooms_persistence', sql`${t.persistence} in ('idle','saving','saved','error')`),
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
    /** The kind of opponent this account faced; rows from before ghosts existed are `human`. */
    opponent_kind: text('opponent_kind').$type<OpponentKind>().notNull().default('human'),
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
    check('results_opponent_kind', sql`${t.opponent_kind} in ('human','ghost','bot')`),
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
    username: text('username').notNull(),
    state: text('state').$type<MatchTicketState>().notNull(),
    room_id: text('room_id').references(() => rooms.id),
    expires_at: ms('expires_at').notNull(),
    created_at: ms('created_at').notNull(),
    updated_at: ms('updated_at').notNull(),
  },
  (t) => [
    check('match_tickets_state', sql`${t.state} in ('waiting','matched')`),
    // Waiting-ticket sweeps (maintenance entry) and per-account TTL refreshes are the hot paths.
    index('match_tickets_state_idx').on(t.state),
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

/**
 * One replayed cast of a recorded opponent trace. `at` is the completion's offset in ms from the
 * match's `started_at` (the raw absolute wall clock is never kept), and `spellIndex` is the cast's
 * own cursor into the shared book — the shape `Runtime` replays one due cast from.
 */
export interface ReplayCast {
  at: number;
  spellIndex: number;
}

/**
 * One recorded opponent: a human seat's complete accepted-cast trace from one finished human
 * match, archived immutably the moment that match settles. `rules_version` fingerprints every
 * rule the trace replays under, so selection serves only current-compatible rows and a protocol
 * or rules change invalidates old ghosts without touching them.
 */
export const ghosts = pgTable(
  'ghosts',
  {
    id: text('id').primaryKey(),
    /** The account whose play was recorded; selection never serves a source their own ghost. */
    source_user_id: text('source_user_id')
      .notNull()
      .references(() => accounts.id),
    theme: text('theme').notNull(),
    /** The match's complete generated book; the trace only replays against exactly it. */
    book: jsonb('book').$type<Spell[]>().notNull(),
    /** The accepted casts, ordered by `spellIndex` from 0 with no gaps. */
    casts: jsonb('casts').$type<ReplayCast[]>().notNull(),
    /** The rule fingerprint the trace was recorded under. */
    rules_version: text('rules_version').notNull(),
    created_at: ms('created_at').notNull(),
  },
  (t) => [
    index('ghosts_source_idx').on(t.source_user_id),
    // Selection scans one version's rows newest-first and stops at a bounded pool.
    index('ghosts_selection_idx').on(t.rules_version, t.created_at),
  ],
);

/**
 * One accepted cast of a live human match, kept until that match settles: publication turns a
 * qualifying trace into a `ghosts` row and deletes the room's rows in the same transaction, so
 * nothing non-qualifying lingers. An abandoned room loses its rows through the room cascade.
 */
export const ghostCasts = pgTable(
  'ghost_casts',
  {
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    match_id: text('match_id').notNull(),
    user_id: text('user_id').notNull(),
    /** Zero-based cursor of the cast's spell in the shared book. */
    spell_index: integer('spell_index').notNull(),
    /** Cast completion, in ms since the match's `started_at`. */
    at: ms('at').notNull(),
  },
  (t) => [
    // One row per accepted cast; a replayed accepted-cast transaction is absorbed, not doubled.
    primaryKey({ columns: [t.match_id, t.user_id, t.spell_index] }),
    // Publication and cleanup always read or delete one room's trace whole.
    index('ghost_casts_room_idx').on(t.room_id),
  ],
);

/** The drizzle schema object every driver instance is bound to. */
export const schema = {
  accounts,
  sessions,
  wechatLoginAttempts,
  wechatRelayTokens,
  runtimeControl,
  rooms,
  players,
  departures,
  results,
  roomSessions,
  matchTickets,
  combatVolleys,
  spellBookCache,
  ghosts,
  ghostCasts,
};

export type DatabaseSchema = typeof schema;

// Row shapes, named for the domain vocabulary the ports carry over from the object storage era.
export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type WechatLoginAttemptRow = typeof wechatLoginAttempts.$inferSelect;
export type WechatLoginAttemptInsert = typeof wechatLoginAttempts.$inferInsert;
export type WechatRelayTokenRow = typeof wechatRelayTokens.$inferSelect;
export type WechatRelayTokenInsert = typeof wechatRelayTokens.$inferInsert;
export type RuntimeControlRow = typeof runtimeControl.$inferSelect;
export type RuntimeControlInsert = typeof runtimeControl.$inferInsert;
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
export type GhostRow = typeof ghosts.$inferSelect;
export type GhostInsert = typeof ghosts.$inferInsert;
export type GhostCastRow = typeof ghostCasts.$inferSelect;
export type GhostCastInsert = typeof ghostCasts.$inferInsert;
