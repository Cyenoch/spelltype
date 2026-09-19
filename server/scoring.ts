/**
 * 房间与测试共用的确定性战斗规则。
 * 此处所有逻辑均为纯函数：无时钟依赖、无持久化存储、无随机性。
 */
import { DAMAGE_PER_CHARACTER } from '../shared/protocol';
import type { Spell } from '../shared/protocol';

/** Unicode 码点数量（代理对计为 1 个字符，孤立代理也计为 1 个）。 */
export function charCount(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/**
 * 完整施放法术造成的伤害值（在目标剩余生命值将其截断前）。
 * 载荷为法术的 Unicode 码点长度，因此更长的法术绝对更具威力，
 * 准确输入是提升输出速率的唯一杠杆。
 */
export function damageOf(text: string): number {
  return DAMAGE_PER_CHARACTER * charCount(text);
}

export interface EditDelta {
  /** 本次快照新引入的字符数（新增与替换）。 */
  inserted: number;
  /** 本次快照删除的字符数；删除绝不计为键入尝试。 */
  deleted: number;
  /** 新引入但与目标文本对应位置不匹配的字符数。 */
  errors: number;
  /** 快照与目标文本匹配的最长前缀（按码点计算）。 */
  progress: number;
}

/**
 * 两次已接受的输入快照与目标文本之间的高可用编辑差异比对。
 *
 * 变更区间是去除最长公共前缀和最长公共后缀后剩余的区域，
 * 因此无论在字符串中间插入、删除还是选区替换，其结算效果都与纯光标模型完全一致。
 * 重放完全相同的快照（如重连、重复消息、输入法完成合成）会全部返回 0，
 * 确保重复传递绝不会虚增尝试次数或准确率。
 */
export function diffSnapshot(previous: string, next: string, target: string): EditDelta {
  const before = Array.from(previous);
  const after = Array.from(next);
  const goal = Array.from(target);

  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix++;

  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  let suffix = 0;
  while (
    suffix < suffixLimit &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;

  const changedEnd = after.length - suffix;
  let inserted = 0;
  let errors = 0;
  for (let i = prefix; i < changedEnd; i++) {
    inserted++;
    if (after[i] !== goal[i]) errors++;
  }

  let progress = 0;
  const progressLimit = Math.min(after.length, goal.length);
  while (progress < progressLimit && after[progress] === goal[progress]) progress++;

  return { inserted, deleted: before.length - suffix - prefix, errors, progress };
}

/**
 * 玩家在私有、单调递增、从 0 开始的索引处对应的法术。
 * 索引在共享法术书上循环取模，因此当对局用时超出法术书容量时，
 * 会按原顺序循环练习法术，而不会出现内容耗尽的情况。
 */
export function spellAt(book: readonly Spell[], index: number): Spell | null {
  if (book.length === 0) return null;
  const wrapped = ((index % book.length) + book.length) % book.length;
  return book[wrapped];
}

export interface MatchStanding {
  userId: string;
  /** 对局结束时的剩余生命值。 */
  hp: number;
  eliminatedAt: number | null;
}

/**
 * 单场对局的最终竞赛排名（例如 1, 1, 3）。
 *
 * 幸存者排在前面，仅按剩余生命值降序排序。阵亡玩家紧随其后，
 * 仅按阵亡时间降序排序；若遭受齐射同时阵亡，则所有受害者具有相同的时间戳。
 * 生命值或阵亡时间相同则并列排名，包括最后幸存者同归于尽时的并列第一名。
 * 输出的统计数据绝不会破坏幸存平局。
 */
export function survivalRanks(standings: readonly MatchStanding[]): Map<string, number> {
  const survivors = standings
    .filter((entry) => entry.eliminatedAt === null)
    .sort((a, b) => b.hp - a.hp);
  const fallen = standings
    .filter(
      (entry): entry is MatchStanding & { eliminatedAt: number } => entry.eliminatedAt !== null,
    )
    .sort((a, b) => b.eliminatedAt - a.eliminatedAt);

  const ranks = new Map<string, number>();
  let rank = 1;
  let index = 0;
  while (index < survivors.length) {
    let last = index;
    while (last + 1 < survivors.length && survivors[last + 1].hp === survivors[index].hp) last++;
    for (let i = index; i <= last; i++) ranks.set(survivors[i].userId, rank);
    rank += last - index + 1;
    index = last + 1;
  }
  index = 0;
  while (index < fallen.length) {
    let last = index;
    while (last + 1 < fallen.length && fallen[last + 1].eliminatedAt === fallen[index].eliminatedAt)
      last++;
    for (let i = index; i <= last; i++) ranks.set(fallen[i].userId, rank);
    rank += last - index + 1;
    index = last + 1;
  }
  return ranks;
}

/**
 * 基于已确认键入尝试的准确率。回退修正不会抹去错误记录；
 * 尝试次数为 0 时返回未知（null），而非满分。
 */
export function accuracyOf(attempts: number, errors: number): number | null {
  if (attempts <= 0) return null;
  const accuracy = (attempts - errors) / attempts;
  return accuracy < 0 ? 0 : accuracy > 1 ? 1 : accuracy;
}

/**
 * 活跃时间内每分钟确认的正确字符数（取整）。`activeSeconds`
 * 仅计算战斗时间（绝不包含大厅等待、生成或倒计时），并在玩家阵亡或对局结束时停止计时。
 */
export function cpmOf(validChars: number, activeSeconds: number): number {
  if (activeSeconds <= 0 || validChars <= 0) return 0;
  return Math.round((validChars / activeSeconds) * 60);
}

/**
 * 下方用于准入资格判定的值仅派生自经过校验的服务器状态。
 * 任何超出判定门限信任范围的数据（零或负数开销、非整数长度、非有限时钟等）
 * 均视为损坏的状态而非放行条件：调用方必须拒绝本次施法，而不是重新计算。
 */
const INPUT_GATE_STATE_INVALID = 'input_gate_state_invalid';

function inputGateLength(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(INPUT_GATE_STATE_INVALID);
  return value;
}

function inputGateTime(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(INPUT_GATE_STATE_INVALID);
  return value;
}

/**
 * 某个在 `openedAt` 开放、长度为 `targetLength` 个码点的法术，
 * 在每个码点最少耗时 `minMsPerCodePoint` 真实毫秒的底线限制下，
 * 最早被允许计入完成的时间戳。底线与长度均为正整数——零耗时绝不能被视作“准备就绪”。
 */
export function inputNotBefore(
  targetLength: number,
  openedAt: number,
  minMsPerCodePoint: number,
): number {
  const length = inputGateLength(targetLength);
  const cost = inputGateLength(minMsPerCodePoint);
  const opened = inputGateTime(openedAt);
  const notBefore = opened + length * cost;
  if (!Number.isSafeInteger(notBefore)) throw new Error(INPUT_GATE_STATE_INVALID);
  return notBefore;
}

/**
 * 计算在 `receivedAt` 收到的完成输入超出输入底线的比率，
 * 表现为实际经过的真实毫秒数相对于法术完整开销的简单比值。
 * 法术开放前为 0；绝不四舍五入、不设上限，且仅作为策略指标，绝非作弊评分。
 */
export function inputCompletionRatio(
  targetLength: number,
  openedAt: number,
  receivedAt: number,
  minMsPerCodePoint: number,
): number {
  const length = inputGateLength(targetLength);
  const opened = inputGateTime(openedAt);
  const received = inputGateTime(receivedAt);
  const cost = inputGateLength(minMsPerCodePoint);
  const elapsed = Math.max(0, received - opened);
  const ratio = elapsed / (length * cost);
  if (!Number.isFinite(ratio)) throw new Error(INPUT_GATE_STATE_INVALID);
  return ratio;
}
