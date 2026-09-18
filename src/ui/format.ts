/**
 * Single source for user-facing vocabulary. Views read these maps directly so
 * a new phase, difficulty, element or end reason cannot fall back to a raw
 * protocol token.
 */
import type { Difficulty, Element, EndReason, Phase } from '../../shared/protocol';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
};

export const DIFFICULTY_HINTS: Record<Difficulty, string> = {
  easy: '目标约 18–26 字，适合热身；实际长度由 AI 生成决定。',
  normal: '目标约 27–38 字，标准长度；实际长度由 AI 生成决定。',
  hard: '目标约 39–50 字，含更多标点；实际长度由 AI 生成决定。',
};

export const ELEMENT_LABELS: Record<Element, string> = {
  arcane: '奥术',
  fire: '火焰',
  ice: '寒冰',
  storm: '雷电',
};

export const PHASE_LABELS: Record<Phase, string> = {
  lobby: '大厅准备',
  generating: '生成咒文',
  countdown: '开场倒数',
  playing: '连续战斗',
  finished: '对局结束',
};

/** How a finished match was decided. Both are legitimate endings, never an error. */
export const END_REASON_LABELS: Record<EndReason, string> = {
  elimination: '场上只剩一名存活者',
  timeout: '时间耗尽，按剩余生命排名',
};

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
export const ELEMENTS: readonly Element[] = ['arcane', 'fire', 'ice', 'storm'];

/** Longest common prefix length, counted in code points. */
export function prefixLength(target: string, typed: string): number {
  const a = Array.from(target);
  const b = Array.from(typed);
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** First index (code points) where typed diverges from target, or -1. */
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

/** Clamp a 0–1 ratio to a 0–100 integer for `aria-valuenow` and bar widths. */
export function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export function clampHealth(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp)) return 0;
  return Math.max(0, Math.min(maxHp > 0 ? maxHp : 0, Math.round(hp)));
}

/** `1234 / 2400` — the one health pair format used by the arena, HUD and results. */
export function formatHealth(hp: number, maxHp: number): string {
  return `${clampHealth(hp, maxHp)} / ${Math.max(0, Math.round(maxHp))}`;
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
