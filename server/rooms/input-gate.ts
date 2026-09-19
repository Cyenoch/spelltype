import { inputNotBefore } from '../scoring';
import type { PlayerRow, RoomRow } from '../db/schema';

/**
 * 输入门控共享的判定逻辑，同时供战斗裁决和快照构建使用。
 *
 * 刻意保持极简：存储字段在 schema 中定义，两条纯时间计算规则位于 scoring，
 * 本模块仅回答“持久化的状态是否连贯合法” —— 从而使损坏的席位在所有地方均以相同的原因
 * 和相同的提示信息被拒绝，避免各调用点产生偏差。不采用复杂的策略框架：一个常量，两个断言函数。
 */

/** 针对持久化资格状态不连贯的进行中席位所返回的唯一拒绝提示。 */
export const INPUT_GATE_ERROR_MESSAGE = '施法状态异常，暂不能施法，请稍后重试。';

/**
 * 当房间锁定的对局策略缺失或格式错误时返回 true。
 * 处于此状态的比赛既不能继续进行，也不能结算写入结果：
 * 策略字段在开局时写入一次，是后续所有决策读取的唯一依据来源。
 */
export function roomPolicyValid(room: RoomRow): boolean {
  return (
    room.input_policy_version !== null &&
    room.input_policy_version.length > 0 &&
    (room.input_policy_mode === 'observe' || room.input_policy_mode === 'enforce') &&
    room.input_min_ms_per_code_point !== null &&
    Number.isSafeInteger(room.input_min_ms_per_code_point) &&
    room.input_min_ms_per_code_point > 0
  );
}

/**
 * 针对不连贯的进行中席位或策略输出单行受限的机器日志。
 * 战斗裁决、比赛结算和倒计时流转均通过此统一格式拒绝损坏状态，
 * 确保各调用点的日志结构不会产生漂移；仅包含供机器关联分析的字段 ——
 * 绝不包含用户身份、连接或任何输入载荷。
 */
export function reportGateStateInvalid(room: RoomRow): void {
  console.error({ event: 'input_gate_state_invalid', roomId: room.id, phase: room.phase });
}

/** 供所有裁决和快照路径读取的资格信息，经一致性校验后作为整体结构返回。 */
export type InputGateState = {
  policyVersion: string;
  mode: 'observe' | 'enforce';
  minMsPerCodePoint: number;
  notBefore: number;
};

/**
 * 席位持久化的资格信息，若损坏则返回 `null`：缺失，或与房间锁定策略下
 * 该法术长度所推导的结果不符。`null` 席位绝不代表“零时刻就绪”：
 * 其自身的快照携带 null 门控外加显式错误，使客户端停止提交，
 * 而不是误以为该损坏状态正常，且其输入会被拒绝。
 * 非空结果携带校验确认后的策略字段，调用方无需针对损坏的数据行重新推导 ——
 * 更无需捏造 —— 模式、开销或就绪时刻。
 */
export function inputGateState(
  room: RoomRow,
  player: PlayerRow,
  spellLength: number,
): InputGateState | null {
  const cost = room.input_min_ms_per_code_point;
  if (
    !roomPolicyValid(room) ||
    cost === null ||
    !Number.isSafeInteger(spellLength) ||
    spellLength <= 0
  ) {
    return null;
  }
  const openedAt = player.input_opened_at;
  const notBefore = player.input_not_before;
  if (
    openedAt === null ||
    notBefore === null ||
    !Number.isSafeInteger(openedAt) ||
    !Number.isSafeInteger(notBefore) ||
    openedAt < 0 ||
    notBefore < 0
  ) {
    return null;
  }
  // 耗尽的世代（epoch）无法表示下一次恢复；裁决和 UI 必须一致判定其已损坏。
  if (
    !Number.isSafeInteger(player.draft_epoch) ||
    player.draft_epoch < 0 ||
    player.draft_epoch === Number.MAX_SAFE_INTEGER
  )
    return null;
  try {
    if (inputNotBefore(spellLength, openedAt, cost) !== notBefore) return null;
  } catch {
    return null;
  }
  // `roomPolicyValid` 刚刚验证了这三个字段；此处的精确类型断言重述了断言函数所证明的保证，
  // 而无需针对它所保证的字段捏造回退值。
  return {
    policyVersion: room.input_policy_version as string,
    mode: room.input_policy_mode as InputGateState['mode'],
    minMsPerCodePoint: cost,
    notBefore,
  };
}
