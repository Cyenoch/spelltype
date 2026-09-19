/**
 * 面向用户的界面词汇唯一数据源。视图直接读取这些映射，
 * 避免新增阶段、元素或结束原因时回退到原始协议标识符。
 */
import {
  THEME_PRESETS,
  type Difficulty,
  type Element,
  type EndReason,
  type OpponentKind,
  type Phase,
} from '../../shared/protocol';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  hard: '困难',
};

export const ELEMENT_LABELS: Record<Element, string> = {
  arcane: '奥术',
  fire: '火焰',
  ice: '寒冰',
  storm: '雷电',
};

export const PHASE_LABELS: Record<Phase, string> = {
  lobby: '大厅准备',
  generating: '准备咒文书',
  countdown: '开场倒数',
  playing: '连续战斗',
  finished: '对局结束',
};

/**
 * 预设主题共享每个主题缓存的咒文书；自定义主题则每局重新生成。
 * 匹配逻辑遵循服务端自身规则：去除首尾空格后的主题文本与预设主题一致。
 */
export function isPresetTheme(theme: string): boolean {
  const trimmed = theme.trim();
  return THEME_PRESETS.some((preset) => preset.theme === trimmed);
}

/**
 * 对局结束判定的判定原因。所有选项均为合法的对局结束方式，绝非错误。
 * 两个衍生结束原因均由对手行为触发：`bot_concession` 为训练对手认输，
 * `inactivity` 则是房间在长时间全员无有效施法时代为结束对局。
 */
export const END_REASON_LABELS: Record<EndReason, string> = {
  elimination: '场上存活者不足两人，战斗结束',
  timeout: '时间耗尽，存活者按剩余生命排名',
  bot_concession: '训练对手认输，战斗结束',
  inactivity: '长时间无有效施法，战斗结束',
};

/** 席位属性。真人席位在 UI 中不加特殊标签；仅非真人类型显示徽章。 */
export const OPPONENT_KIND_LABELS: Record<OpponentKind, string> = {
  human: '真人',
  ghost: '幻影',
  bot: '机器人',
};

export const ELEMENTS: readonly Element[] = ['arcane', 'fire', 'ice', 'storm'];

/** 最长公共前缀长度，以 Unicode 码点（code points）计数。 */
export function prefixLength(target: string, typed: string): number {
  const a = Array.from(target);
  const b = Array.from(typed);
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** 输入文本与目标文本首次出现不一致的索引（码点计数），无不匹配则返回 -1。 */
export function firstMismatch(target: string, typed: string): number {
  const a = Array.from(target);
  const b = Array.from(typed);
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

export function formatSeconds(ms: number): string {
  const clamped = Math.max(0, ms);
  return (clamped / 1000).toFixed(1);
}

export function formatRatioPercent(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function formatAccuracyPercent(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 将 0~1 的比率限制并转换为 0~100 的整数，用于 `aria-valuenow` 和进度条宽度。 */
export function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * 规范化的游戏数值显示：整数保持原样，小数最多保留两位且无多余末尾 0。
 * 均分伤害如 `40 / 3` 显示为 `13.33`，绝不显示为 `13.333333333333334`；
 * UI 中展示的所有伤害或生命数值均通过本函数格式化。
 */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function clampHealth(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp)) return 0;
  return Math.max(0, Math.min(maxHp > 0 ? maxHp : 0, hp));
}

/**
 * `1234 / 2400` —— 竞技场、HUD 和结算界面共用的生命值对格式。
 * 生命值可能为小数（均分伤害），因此两端均通过 `formatAmount` 处理而非直接四舍五入抹去小数。
 */
export function formatHealth(hp: number, maxHp: number): string {
  return `${formatAmount(clampHealth(hp, maxHp))} / ${formatAmount(Math.max(0, maxHp))}`;
}

export function formatTimestamp(seconds: number): string {
  if (!seconds) return '—';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
