/**
 * Deterministic combat rules shared by the room and its tests.
 * Everything here is pure: no clock, no storage, no randomness.
 */
import { DAMAGE_PER_CHARACTER } from '../shared/protocol';
import type { Spell } from '../shared/protocol';

/** Unicode code point count (a surrogate pair counts once, lone surrogates once). */
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
 * Damage of one completed spell, before the target's remaining health clamps it.
 * The payload is the spell's Unicode code point length, so a longer spell is
 * strictly stronger and accurate typing is the only throughput lever.
 */
export function damageOf(text: string): number {
  return DAMAGE_PER_CHARACTER * charCount(text);
}

export interface EditDelta {
  /** Characters newly introduced by this snapshot (insertions and replacements). */
  inserted: number;
  /** Characters removed by this snapshot; deletions are never typing attempts. */
  deleted: number;
  /** Newly introduced characters that do not match the target at their position. */
  errors: number;
  /** Longest prefix of the snapshot that matches the target, in code points. */
  progress: number;
}

/**
 * Robust edit-diff between two accepted input snapshots against the target text.
 *
 * The changed span is the region left after stripping the longest common prefix
 * and the longest common suffix, so mid-string insertion, deletion and
 * selection-replacement all produce the same accounting a caret-only model
 * would. Replaying an identical snapshot (reconnect, duplicate message,
 * composition end) yields all zeros, so repeated delivery cannot inflate
 * attempts or accuracy.
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
 * A player's spell for a private, monotonic, zero-based index. The index wraps
 * around the shared book, so a match longer than the book repeats the same
 * ordered practice spells instead of running out of content.
 */
export function spellAt(book: readonly Spell[], index: number): Spell | null {
  if (book.length === 0) return null;
  const wrapped = ((index % book.length) + book.length) % book.length;
  return book[wrapped];
}

export interface MatchStanding {
  userId: string;
  /** Remaining health at the end of the match. */
  hp: number;
  eliminatedAt: number | null;
}

/**
 * Final competition ranks (1, 1, 3) for one match.
 *
 * Survivors come first, ordered only by remaining health. Fallen players follow,
 * ordered only by elimination time; a simultaneous volley gives every victim the
 * same timestamp. Equal health or elimination time means a shared rank, including
 * first place when the last survivors knock each other out. Output statistics
 * never break a survival tie.
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
 * Accuracy over confirmed typing attempts. Corrections never erase an error;
 * zero attempts is unknown, not a perfect score.
 */
export function accuracyOf(attempts: number, errors: number): number | null {
  if (attempts <= 0) return null;
  const accuracy = (attempts - errors) / attempts;
  return accuracy < 0 ? 0 : accuracy > 1 ? 1 : accuracy;
}

/**
 * Correct confirmed characters per active minute, whole number. `activeSeconds`
 * is combat time only (never lobby, generation or countdown) and stops at the
 * player's elimination or at the end of the match.
 */
export function cpmOf(validChars: number, activeSeconds: number): number {
  if (activeSeconds <= 0 || validChars <= 0) return 0;
  return Math.round((validChars / activeSeconds) * 60);
}

/**
 * The eligibility values below are derived only from validated server state. Anything outside the
 * shape the gate can trust — a zero or negative cost, a half-integer length, a non-finite clock —
 * is corrupted state, not a free pass: the caller must refuse the cast rather than recompute.
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
 * Earliest instant the completion of a `targetLength`-code-point spell, made available at
 * `openedAt`, may count under a floor of `minMsPerCodePoint` real milliseconds per code point.
 * Both the floor and the length are positive whole numbers — a zero cost is never "ready".
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
 * How far past the floor a completion received at `receivedAt` got, as a plain ratio of real
 * elapsed milliseconds to the spell's full cost. Zero before the spell was available; never
 * rounded, never capped, and a policy metric only — never a cheat score.
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
