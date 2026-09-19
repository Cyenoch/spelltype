import { MAX_MESSAGE_BYTES } from '../../shared/protocol';
import type { Phase } from '../../shared/protocol';
import type { RoomRow } from '../db/schema';

/** 从未连接/断开连接的大厅席位在闲置达到此时间后可被回收。 */
export const SEAT_TTL_MS = 120_000;
/** 私人对局需要两名已连接且愿意开始的玩家。 */
export const MIN_PLAYERS = 2;
/** 单次追赶处理最多执行此数量的到期流转，防止长期停机导致死循环。 */
export const MAX_CATCHUP_STEPS = 32;
/** 此 UTF-16 长度的 JS 字符串必然 <= MAX_MESSAGE_BYTES UTF-8 字节。 */
export const MESSAGE_LENGTH_FAST_PATH = Math.floor(MAX_MESSAGE_BYTES / 3);
/** 真人打字员合并后的快照频率远低于此数值。 */
export const INPUTS_PER_SECOND = 60;

/**
 * 每一场计分比赛所标记的打字时间策略。提高或降低下方底线
 * 均属于全新版本，绝非静默修改：版本号在比赛生命周期内冻结在房间数据行、
 * 结果数据行以及每一个快照中。
 */
export const INPUT_POLICY_VERSION = 'ascii-floor-v1';
/** 在该法术完成计算前，每个目标码点所需的实际毫秒数。 */
export const INPUT_MIN_MS_PER_CODE_POINT = 35;

/** 其 `deadline` 作为权威时钟的阶段：开局倒计时，以及随后的单次战斗终点。 */
export const TIMED_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: false,
};

/** 正在生成或进行比赛的阶段：生成中、开局倒计时与战斗中。 */
export const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** 共享法术书向每个席位公开展示的阶段。 */
export const BOOK_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: true,
};

/**
 * 当该房间处于观众当前可实时观看的决斗状态时返回 true：战斗阶段处于活跃中且
 * 其唯一截止时间尚未过去。大厅、生成中、倒计时、已结算比赛以及运行时尚未追赶上的截止时间
 * 均被排除 —— 由时钟决定，绝不由本地定时器决定。
 */
export function duelIsOngoing(room: RoomRow, now: number): boolean {
  return room.phase === 'playing' && room.deadline > now;
}

/**
 * 快速预留仅在其截止时间之前有效：由时钟决定，因此
 * 延迟的追赶处理绝不会让迟到的玩家加入或基于失效的凭证开始游戏。
 */
export function reservationIsLive(room: RoomRow, now: number): boolean {
  return (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    now < room.reservation_expires_at
  );
}

/**
 * 当快速配对完全无法再被加入时返回 true：已取消、自身时钟超时、
 * 或已被对局消耗。过期的定位器必须读取到与房间自身握手完全相同的拒绝响应。
 */
export function reservationIsGone(room: RoomRow, now: number): boolean {
  return (
    room.mode === 'quick' &&
    (room.reservation_state === 'cancelled' ||
      room.reservation_state === 'expired' ||
      (room.reservation_state === 'reserved' && !reservationIsLive(room, now)))
  );
}
