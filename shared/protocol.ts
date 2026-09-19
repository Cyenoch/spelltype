/**
 * 浏览器客户端、稳定 API 和游戏运行时共用的通信传输契约。
 * 跨越网络边界的一切数据均在此描述。
 *
 * 游戏采用连续生命值战斗机制：一本生成的咒文书，一局共同承受与输出伤害的玩家，
 * 直到仅剩一名存活玩家或单场对局截止时间到达。
 *
 * 所有同时具备运行时校验器的类型均通过类型导入从 `shared/validation.ts` schema 推导而来，
 * 确保数据结构只声明一次，二者永不发生分歧。
 */
import type { z } from 'zod';
import type {
  clientMessageSchema,
  elementSchema,
  roomInitSchema,
  roomModeSchema,
} from './validation';

/**
 * 产品提供的单一咒文难度。每个房间 —— 无论是私人房还是快速匹配 —— 均硬编码初始化为 hard，
 * 请求无法再自选难度；保留该类型是因为持久化房间和快照仍携带此值。
 */
export type Difficulty = 'hard';
export type Element = z.infer<typeof elementSchema>;
/** 房间创建来源：房主的私人房，或匹配系统配对。 */
export type RoomMode = z.infer<typeof roomModeSchema>;
/**
 * 席位对手类型。`human` 为普通账号；`ghost` 为匹配超时未找到真人对手时入座的真实玩家录像回放；
 * `bot` 为生成的规则驱动对手。合成席位绝不会伪装成离线真人。
 */
export type OpponentKind = 'human' | 'ghost' | 'bot';
export type Phase = 'lobby' | 'generating' | 'countdown' | 'playing' | 'finished';
/**
 * 战斗结束原因：最多仅剩一名存活者、对局截止时间到达，或合成对手主动结束对局
 * （`bot_concession`：对手向活跃玩家认输；`inactivity`：全员在整个停滞窗口内未打出任何咒文）。
 */
export type EndReason = 'elimination' | 'timeout' | 'bot_concession' | 'inactivity';
/** 房间视角的对局结算结果持久化状态。 */
export type Persistence = 'idle' | 'saving' | 'saved' | 'error';
/** 房间席位的预留生命周期，用于对齐匹配票据状态。 */
export type ReservationState = 'none' | 'reserved' | 'cancelled' | 'expired' | 'locked';

export const WS_PROTOCOL = 'spelltype.v4';
export type InputPolicyMode = 'observe' | 'enforce';

export type SelfInputGate = null | {
  policyVersion: string;
  mode: InputPolicyMode;
  draftEpoch: number;
  notBefore: number;
  resetReason: null | 'completion_too_early';
};

export type SelfInputStats = null | {
  attemptTotal: number;
  errorTotal: number;
};
export interface ThemePreset {
  id: string;
  label: string;
  theme: string;
}

/** 私人房间主题选项与快速匹配池；每个预设主题拥有一本独立的共享咒文书。 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'academy', label: '正统魔法学院', theme: '正统魔法学院的期末考试' },
  { id: 'courtyard', label: '深夜炼金工坊', theme: '深夜炼金工坊的失控事故' },
  { id: 'immortal', label: '修真斗法', theme: '仙门斗法大会的紫霄剑诀' },
  { id: 'comedy', label: '整活魔法', theme: '用魔法点外卖的离谱日常' },
  { id: 'deepsea', label: '深海咒术', theme: '深海遗迹里的古老封印' },
  { id: 'bakery', label: '魔法面包房', theme: '魔法面包房的清晨配方' },
];

/** 共享限制使浏览器、API 和游戏运行时保持相同的边界。 */
export const MAX_THEME_CHARS = 80;
export const MAX_INPUT_CHARS = 256;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_API_BODY_BYTES = 8192;
export const MAX_PRIVATE_PLAYERS = 4;
export const MAX_QUICK_PLAYERS = 2;
/** 快速匹配席位预留生存时间，镜像反映在 MatchTicket.expiresAt 中。 */
export const RESERVATION_TTL_MS = 60_000;
/** 匹配排队条目的生存时间；每次状态轮询都会刷新。 */
export const QUEUE_ENTRY_TTL_MS = 60_000;
/**
 * 快速匹配等待真人对手的时长，超时后匹配系统将安排合成对手。
 * 服务端依据票据的 `createdAt` 计算阈值；排队页面引用同一数值以确保承诺的回退与服务端执行一致。
 */
export const QUICK_GHOST_FALLBACK_MS = 30_000;
/**
 * 在合成对手对局中，战斗在没有成功施法的情况下可进行的时长，超过后房间将不再留手：
 * 从此时起对手的攻击将具有致命伤害。对局仍通过常规伤害结算（若人类玩家一直在施法则为 `bot_concession`）
 * 或对局截止时间结束（全员挂机则为 `inactivity`）。结算面板在说明中引用同一数值。
 */
export const BOT_IDLE_MS = 45_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 战斗规则。房间对所有规则具备最终权威；客户端仅需相同数值即可在无需等待快照的情况下渲染生命值、咒文计数器与时钟。
 */
/** 3秒开局倒计时，随后是该固定长度的单段不中断战斗阶段。 */
export const OPENING_COUNTDOWN_MS = 3_000;
/** 战斗总时长。对局截止时间设定后绝不延长。 */
export const MATCH_DURATION_MS = 240_000;
/** 固定服务端时间窗口；窗口内所有被接受的施法同时生效。 */
export const COMBAT_BATCH_MS = 100;
/** 所有玩家满血开始，生命值上限亦为初始满血值。 */
export const INITIAL_HEALTH = 2400;
/** 每个 Unicode 码点对应的总咒文伤害，均摊给所有存活的对手。 */
export const DAMAGE_PER_CHARACTER = 4;
/**
 * 每场对局一本不可变的有序咒文书，预设主题跨对局共享。
 * 每位玩家仅接收其当前正在输入的咒文，以私有的从零开始索引推进；
 * 索引 `mod SPELL_BOOK_SIZE` 回绕至相同的不同咒文，因此长于咒文书的对局会循环练习咒文而不会卡死。
 */
export const SPELL_BOOK_SIZE = 24;
/** 房间保留并广播的最近战斗事件数量（环形缓冲区，最新在末尾）。 */
export const COMBAT_EVENT_RING_SIZE = 32;

export interface User {
  id: string;
  username: string;
}

export interface Spell {
  name: string;
  text: string;
  /** 英文 `text` 的简体中文释义，打字时显示在咒文下方。 */
  translation: string;
  element: Element;
}

export interface Player extends User {
  /** 稳定的展示席位编号，从 0 开始；席位绝不影响伤害分配。 */
  slot: number;
  /** 席位类型：普通账号、录像回放或生成的对手。 */
  kind: OpponentKind;
  connected: boolean;
  ready: boolean;
  /** 该玩家当前咒文文本已被接受的最长前缀长度。 */
  progress: number;
  /** 该玩家当前咒文的码点长度，咒文书公开前为 0。 */
  spellLength: number;
  /** 该玩家在共享咒文书中的私有、单调递增、从零开始的咒文游标。 */
  spellIndex: number;
  /** 该玩家在本次对局中已完成的咒文数。 */
  spellsCast: number;
  hp: number;
  maxHp: number;
  /** 实际扣除的 HP，在批次过量击杀时按比例计入；可能为小数。 */
  damageDealt: number;
  /**
   * 该玩家已完成咒文中已确认正确的字符数，在整场对局中单调递增。
   * 当前已被接受的前缀不包含在此计数中（咒文未完成时为计算 CPM 而临时计入）。
   */
  correctChars: number;
  /** 战斗击杀的批次结束时间，或立即弃赛的时间；存活时为 null。 */
  eliminatedAt: number | null;
  /**
   * 每分钟活跃击键数（`correctChars` + 当前已接受前缀）；
   * 活跃时间自战斗开始起算，至该玩家被淘汰或对局结束止，绝不计入大厅/生成/倒计时。
   */
  cpm: number;
  /** 玩家尚未产生被计数的击键时为 `null`。 */
  accuracy: number | null;
  /** 对局结束后的竞技名次；对局进行中为 `null`。 */
  rank: number | null;
}

/**
 * 同时结算的齐射攻击中，单次施法对单名对手的伤害贡献。
 * 共享相同 `at` 的事件同时生效；每个事件拥有唯一的 seq。此处绝不暴露咒文文本。
 */
export interface CombatEvent {
  /** 每场对局单调自增，从 1 开始；客户端依靠 `(matchId, seq)` 去重。 */
  seq: number;
  /** 权威批次结算时间戳，齐射中的所有命中事件共享该时间。 */
  at: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  /** 整个批次结算后目标的最终 HP，并非击中过程中的中间状态。 */
  targetHp: number;
  /** 产生此次命中的攻击者咒文索引。 */
  spellIndex: number;
  /** 每个新被淘汰的目标生成一个事件标记，用于界面展示 KO。 */
  eliminated: boolean;
}

/**
 * 权威房间状态。`selfInput` 与 `spell` 字段按接收者隔离：
 * 房间仅下发玩家自己的当前咒文及其自身被接受的草稿，绝不下发整本书或对手的草稿。
 */
export interface RoomSnapshot {
  protocolVersion: string;
  id: string;
  matchId: string | null;
  hostId: string;
  mode: RoomMode;
  /**
   * 房间对手安排：普通房间为 `human`，快速匹配超时未匹配到真人时为合成对手类型。
   */
  opponentKind: OpponentKind;
  theme: string;
  difficulty: Difficulty;
  phase: Phase;
  /** 开局倒计时结束时间，随后为单段战斗结束时间。无时钟阶段为 `0`。 */
  deadline: number;
  serverNow: number;
  /** 战斗阶段开始时间戳，开始前为 `null`。 */
  startedAt: number | null;
  /** 对局结算时间戳，进行中为 `null`。 */
  endedAt: number | null;
  endReason: EndReason | null;
  spell: Spell | null;
  selfInput: string;
  selfInputGate: SelfInputGate;
  selfInputStats: SelfInputStats;
  /** 环形最近伤害事件记录，最旧在前；首次命中前为空。 */
  events: CombatEvent[];
  persistence: Persistence;
  reservationExpiresAt: number | null;
  players: Player[];
  error: string | null;
}

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: 'state'; room: RoomSnapshot }
  | { type: 'error'; message: string }
  | { type: 'pong'; serverNow: number };

export type RoomInit = z.infer<typeof roomInitSchema>;

export interface MatchTicket {
  state: 'waiting' | 'matched';
  /** 仅在 `state` 为 `matched` 时存在。 */
  roomId?: string;
  /** `waiting` 状态下为排队过期时间（轮询刷新）。`matched` 状态下为席位预留过期时间。 */
  expiresAt: number;
}

export interface MatchCancelResult {
  /**
   * 当此账号既无排队票据亦无活跃的赛前预留时为 `true`（幂等：无内容需取消时亦为 `true`）。
   * 当已开始的对局仍占用此账号席位时为 `false`。
   */
  cancelled: boolean;
}

/**
 * 单个账号的单条持久化对局记录，由 `GET /api/profile` 返回。
 */
export interface MatchResult {
  match_id: string;
  theme: string;
  /** 该账号面对的对手类型；合成对局将永久保留标识。 */
  opponent_kind: OpponentKind;
  damage_dealt: number;
  /** 对局结算时剩余的生命值；被淘汰时为 `0`。 */
  hp_remaining: number;
  spells_cast: number;
  correct_chars: number;
  /** 仅限实际战斗时长；在战斗开始前结束的对局为 `0`。 */
  duration_ms: number;
  rank: number;
  cpm: number;
  /** 账号未产生被计数的击键时为 `null`；该状态代表未知，而非 0% 或 100%。 */
  accuracy: number | null;
  created_at: number;
  input_policy_version: string;
  input_policy_mode: 'observe' | 'enforce' | null;
  input_gate_hits: number | null;
  input_recoveries: number | null;
  input_min_completion_ratio: number | null;
  input_overloads: number | null;
  input_recovered_completions: number | null;
  input_recovery_departures: number | null;
}

export interface Profile {
  user: User;
  stats: { games: number; wins: number; bestCpm: number };
  history: MatchResult[];
}

/** `GET /api/activity` — 仅首页计数器；绝不包含房间 ID、用户名或私有状态。 */
export interface ActivitySummary {
  /** 当前正处于战斗阶段的房间数，包含私人房和快速匹配。 */
  activeDuels: number;
  /** 持有有效且尚未配对的排队条目的账号数。 */
  waitingPlayers: number;
}

export type AccountRole = 'user' | 'admin';

/**
 * `GET /api/session` — 绝不暴露机密信息或提供商内部错误细节。
 */
export interface SessionInfo {
  user: User | null;
  role: AccountRole | null;
}

/**
 * 房间可能发送的 WebSocket 关闭码。共享以防止客户端、房间和路由器发生分歧：
 * `replaced`/`closed`/`sessionExpired` 为终止性关闭（停止重连），
 * `restart` 为可恢复关闭（通过 HTTP 重新核验会话与房间，然后重试）。
 */
export const WS_CLOSE = {
  /** 另一连接顶替了该账号在房间中的席位。 */
  replaced: 4000,
  /** 房间已结束本次预留或对局；已无对象可供重连。 */
  closed: 4001,
  /** 会话已过期或已被撤销：重试前请重新鉴权。 */
  sessionExpired: 4002,
  /** 重连前请更新客户端。 */
  protocolMismatch: 4003,
  /** 输入速率超限：请至少等待一秒后再重连。 */
  inputOverload: 4004,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** 可恢复重启提示；握手被拒（401/404/409）在客户端表现为 1006。 */
export const WS_CLOSE_RESTART = 1012;
