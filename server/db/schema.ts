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
 * 完整的持久化数据库：微信认证账户与登录状态、会话、房间、席位和
 * 匹配票据——以及用于掌控维护模式和全局运行时租约的唯一单例行 `runtime_control`。
 *
 * PostgreSQL 和本地开发用的 PGlite 共享这套 Drizzle schema 以及生成的迁移脚本。房间、
 * 玩家以及全局队列票据保存在同一数据库中，确保匹配配对与席位创建能原子提交。
 *
 * 设计约定：
 * - 属性名采用 snake_case 以匹配现有的领域行词汇；导出的表名为 camelCase。
 * - 所有毫秒时间戳和截止时间均为 `bigint(..., { mode: 'number' })`——延续房间计时器一直采用的
 *   整数毫秒约定，在 PG 中足够安全，因为 epoch ms 完全能放入 double 中。
 * - 小型状态词汇表（阶段、模式、票据状态）使用带有 `CHECK` 约束的 `text`，并在 TypeScript 中进行类型约束，
 *   保持与原有领域逻辑一致；不使用 PostgreSQL 自定义 enum 类型。
 * - `locked`/`seated`/`ready` 保留历史上的 0/1 整数约定，而非布尔类型。
 * - 序列化的领域 JSON（`spell_book`, `events_json`）保存在 `text` 列中；不存在第二个数据库或发件箱来模拟以前的对象存储。
 */

/** 毫秒级时间戳列：领域唯一的标准时间单位。 */
const ms = (name: string) => bigint(name, { mode: 'number' });

export type MatchTicketState = 'waiting' | 'matched';

/**
 * 微信身份账户。`username` 是来自桥接资料的显示昵称，特意允许重复；
 * `wechat_identity`（`union:<unionid>` 或 `open:<openid>`/`mp:<openid>`）是唯一稳定且唯一的凭证。
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    wechat_identity: text('wechat_identity').notNull().unique(),
    /** 管理角色（默认为 `user`；`admin` 可使用维护工具）。游戏通信数据中从不携带此项。 */
    role: text('role').$type<AccountRole>().notNull().default('user'),
    created_at: ms('created_at').notNull(),
  },
  (t) => [check('accounts_role', sql`${t.role} in ('user','admin')`)],
);

/** 仅存储会话令牌的摘要（哈希），从不直接存储令牌明文。 */
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
 * 单次发起的微信 OAuth 尝试。`state` 参数的 SHA-256（其明文也保存在 `spelltype_wechat_state` cookie 中）
 * 作为单次有效的主键，因此仅当回调携带的状态由此处签发、尚未过期并在同一事务中被删除时，回调才算成功。
 * `room_id` 记录该次登录所由发起的房间邀请（可选）。
 */
export const wechatLoginAttempts = pgTable('wechat_login_attempts', {
  state_hash: text('state_hash').primaryKey(),
  room_id: text('room_id'),
  expires_at: ms('expires_at').notNull(),
});

/**
 * 已经在回调时兑现过的桥接中继令牌 `jti`。将其持久化存储直到令牌自身的过期时间，
 * 即使登录尝试记录已从数据库删除，也能证明被重放的回调令牌已被单次使用。
 */
export const wechatRelayTokens = pgTable('wechat_relay_tokens', {
  jti: text('jti').primaryKey(),
  expires_at: ms('expires_at').notNull(),
});

/**
 * 全局唯一的控制单例行：维护模式、其 CAS 版本号以及单运行时的所有权租约。
 * 游戏中的每一次准入判定、每一次状态流转和每一次写入栅障都会经由此行串行化，因此该行经过精心设计，
 * 极致小巧——只有一行，以两种锁模式之一锁定（用于读取/准入的 `FOR SHARE`，用于状态变更的 `FOR UPDATE`）。
 */
export const runtimeControl = pgTable(
  'runtime_control',
  {
    singleton: integer('singleton').primaryKey().default(1),
    mode: text('mode').$type<MaintenanceMode>().notNull(),
    /** 维护状态流转的 CAS 令牌；每次提交变更时自增。 */
    revision: integer('revision').notNull().default(0),
    updated_at: ms('updated_at').notNull(),
    /** 当前运行时所有者的标识令牌；无运行时持有租约时为 `null`。 */
    runtime_id: text('runtime_id'),
    /** 单调递增的所有权世代号，在每次全新申领或接管租约时递增。 */
    runtime_epoch: integer('runtime_epoch').notNull().default(0),
    /** 依据数据库系统时钟判定的截止时间，超过该时间租约被视作失效。 */
    lease_until: ms('lease_until'),
  },
  (t) => [
    check('runtime_control_singleton', sql`${t.singleton} = 1`),
    check('runtime_control_mode', sql`${t.mode} in ('open','draining')`),
  ],
);

/** 单个房间：对局实时状态。维护状态是全局的，因此房间自身不包含维护标志。 */
export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    host_id: text('host_id').notNull(),
    mode: text('mode').$type<RoomMode>().notNull(),
    theme: text('theme').notNull(),
    difficulty: text('difficulty').$type<Difficulty>().notNull(),
    phase: text('phase').$type<Phase>().notNull(),
    /** 开场倒计时结束时间，其后为战斗结束时间；无计时器阶段为 `0`。 */
    deadline: ms('deadline').notNull().default(0),
    started_at: ms('started_at'),
    ended_at: ms('ended_at'),
    end_reason: text('end_reason').$type<EndReason>(),
    match_id: text('match_id'),
    /** 非房主席位容纳的对手类型：真人玩家、录制重放的重影对手（ghost）或生成的机器人。 */
    opponent_kind: text('opponent_kind').$type<OpponentKind>().notNull().default('human'),
    /** 当 `opponent_kind` 为 `ghost` 时的重影对手记录行；其他所有房间均为 `null`。 */
    ghost_id: text('ghost_id'),
    /** 对手下一次预定施法的持久化截止时间毫秒数；无预定施法时为 `null`。 */
    opponent_next_at: ms('opponent_next_at'),
    /** 本局生成的有序法术书，供所有席位共享。 */
    spell_book: text('spell_book'),
    /** 有界伤害历史环形缓冲区，按时间从旧到新排列，以 JSON 格式存储。 */
    events_json: text('events_json').notNull().default('[]'),
    /** 环形缓冲区中最新事件的序列号；客户端据以通过 `(match_id, seq)` 进行去重。 */
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
    /** 归属运行时必须唤醒的下一个持久化截止时间；在进程启动时恢复。 */
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

/** 单个席位。预留席位在其账户连接前就已存在。 */
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
    /** 账户实际建立连接后置为 1；预留的受邀席位保持为 0。 */
    seated: integer('seated').notNull().default(0),
    ready: integer('ready').notNull().default(0),
    /** 当前玩家对当前法术所输入的最长匹配前缀长度。 */
    progress: integer('progress').notNull().default(0),
    /** 玩家私有的、单调递增的共享法术书从零索引起始光标。 */
    spell_index: integer('spell_index').notNull().default(0),
    spells_cast: integer('spells_cast').notNull().default(0),
    hp: doublePrecision('hp').notNull().default(INITIAL_HEALTH),
    max_hp: integer('max_hp').notNull().default(INITIAL_HEALTH),
    damage_dealt: doublePrecision('damage_dealt').notNull().default(0),
    /** 已完成法术的确认字符数；不计入当前正在输入的实时前缀。 */
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
 * 单场已结束比赛中单个账户的结算结果行，与房间终态原子提交。
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
    /** 该账户在本局面对的对手类型；重影系统诞生前的历史数据记为 `human`。 */
    opponent_kind: text('opponent_kind').$type<OpponentKind>().notNull().default('human'),
    /** 本局比赛中该账户对对手造成的伤害总量。 */
    damage_dealt: doublePrecision('damage_dealt').notNull(),
    /** 对局结算时剩余的生命值（该账户被击杀淘汰时为 0）。 */
    hp_remaining: doublePrecision('hp_remaining').notNull(),
    spells_cast: integer('spells_cast').notNull(),
    correct_chars: integer('correct_chars').notNull(),
    /** 仅包含有效战斗时间，不包含大厅等待、生成或倒计时时间。 */
    duration_ms: integer('duration_ms').notNull(),
    rank: integer('rank').notNull(),
    cpm: integer('cpm').notNull(),
    /** 该账户未产生任何有效按键时为 `null`：此时不存在诚实的 0% 或 100% 准确率。 */
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
    // 主键保证重试写入具有幂等性。
    primaryKey({ columns: [t.match_id, t.user_id] }),
    check('results_opponent_kind', sql`${t.opponent_kind} in ('human','ghost','bot')`),
    index('results_user_recent_idx').on(t.user_id, t.created_at.desc()),
  ],
);

/**
 * 账户主动退出当前房间的手动离场记录。`match_id` 标明被中途放弃的对局；
 * 若在对局产生前便释放席位，该值为 `null`，此时本行仅充当幂等标记。
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
 * 会话所持有的活跃房间席位，以便在撤销会话时能一并关闭对应的套接字连接。
 * 此处仅保存令牌摘要（哈希），与 `sessions` 表一致；从不保存令牌明文。
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
 * 共享匹配表：单个账户的单张票据兼作全局占位记录，因此“该账户是否已在某处占用席位”
 * 是单次主键查询，配对与房间初始化得以在单个事务内原子完成。
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
    // 扫描等待中的票据（进入维护模式时）和基于账户的 TTL 刷新属于高频热点路径。
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

/** 已接受的施法意图，在结算失败或运行时重启时仍能留存。 */
export const combatVolleys = pgTable('combat_volleys', {
  room_id: text('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  match_id: text('match_id').notNull(),
  ends_at: ms('ends_at').notNull(),
  roster: jsonb('roster').$type<string[]>().notNull(),
  casts: jsonb('casts').$type<PendingCast[]>().notNull(),
});

/** 全局共享的单个预设法术书及其带锁刷新的租约。 */
export const spellBookCache = pgTable('spell_book_cache', {
  theme: text('theme').primaryKey(),
  book: jsonb('book').$type<Spell[]>(),
  published_at: ms('published_at'),
  token: text('token'),
  lease_expires_at: ms('lease_expires_at'),
});

/**
 * 录制的对手轨迹中的单次重放施法。`at` 是施法完成时间相对于比赛 `started_at` 的毫秒偏移
 * （从不保留绝对物理挂钟时间），`spellIndex` 是该施法在共享法术书内的光标——即 `Runtime` 重放预定施法所需的数据结构。
 */
export interface ReplayCast {
  at: number;
  spellIndex: number;
}

/**
 * 单条已录制的对手轨迹：来自一场已结束真人对局的真人席位完整已确认施法轨迹，
 * 在该对局结算完成的瞬间不可变归档。`rules_version` 对该轨迹重放所依据的每条规则进行指纹标记，
 * 使得筛选时只取与当前版本兼容的行，协议或规则变更无需修改历史重影即可使其自动失效。
 */
export const ghosts = pgTable(
  'ghosts',
  {
    id: text('id').primaryKey(),
    /** 游戏过程被录制的来源账户；筛选时从不向本人发放其自身的重影。 */
    source_user_id: text('source_user_id')
      .notNull()
      .references(() => accounts.id),
    theme: text('theme').notNull(),
    /** 该对局生成的完整法术书；轨迹仅在该法术书下严密重放。 */
    book: jsonb('book').$type<Spell[]>().notNull(),
    /** 已确认的施法列表，按 `spellIndex` 从 0 开始无空缺严格排序。 */
    casts: jsonb('casts').$type<ReplayCast[]>().notNull(),
    /** 录制该轨迹时依据的规则指纹。 */
    rules_version: text('rules_version').notNull(),
    created_at: ms('created_at').notNull(),
  },
  (t) => [
    index('ghosts_source_idx').on(t.source_user_id),
    // 筛选操作按规则版本由新到旧扫描行，并在达到限定容量池时停止。
    index('ghosts_selection_idx').on(t.rules_version, t.created_at),
  ],
);

/**
 * 真人对局中单次被接受的施法，一直保留至该比赛结算：归档发布时会将合格的轨迹转入
 * `ghosts` 表，并在同一事务中删除该房间的所有行，确保不留存任何不合格记录。
 * 被中途放弃的房间则通过房间级联删除清理其数据行。
 */
export const ghostCasts = pgTable(
  'ghost_casts',
  {
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    match_id: text('match_id').notNull(),
    user_id: text('user_id').notNull(),
    /** 该法术在共享法术书中的从零开始光标位置。 */
    spell_index: integer('spell_index').notNull(),
    /** 施法完成时间，相对于比赛 `started_at` 的毫秒数。 */
    at: ms('at').notNull(),
  },
  (t) => [
    // 每次被接受的施法对应一行；重放已确认的施法事务会被吸收而不会重复插入。
    primaryKey({ columns: [t.match_id, t.user_id, t.spell_index] }),
    // 发布与清理操作始终按房间完整读取或删除整个轨迹。
    index('ghost_casts_room_idx').on(t.room_id),
  ],
);

/** 驱动实例绑定的 Drizzle schema 导出对象。 */
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

// 数据行类型，沿用对象存储时代领域端口保留下来的领域命名规范。
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
