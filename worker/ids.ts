import { randomUUID } from 'node:crypto';
import { MAX_THEME_CHARS } from '../shared/protocol';
import type { Difficulty } from '../shared/protocol';

/** Room identity: 24 lowercase hex characters, generated with a secure RNG. */
export const ROOM_ID_PATTERN = /^[0-9a-f]{24}$/;

export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

const DIFFICULTIES: Record<string, true> = { easy: true, normal: true, hard: true };

/** Narrows an untrusted request value to a difficulty, or `null`. */
export function readDifficulty(value: unknown): Difficulty | null {
  return typeof value === 'string' && DIFFICULTIES[value] === true ? (value as Difficulty) : null;
}

/** Theme input, trimmed and length-checked. Themes are stored and passed through verbatim. */
export function readTheme(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const theme = value.trim();
  if (theme.length === 0 || [...theme].length > MAX_THEME_CHARS) return null;
  return theme;
}
