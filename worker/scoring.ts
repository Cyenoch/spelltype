/**
 * Deterministic combat rules shared by the room and its tests.
 * Everything here is pure: no clock, no storage, no randomness.
 */
import { DAMAGE_PER_CHARACTER, MAX_PRIVATE_PLAYERS } from '../shared/protocol';
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

/**
 * Automatic target: the next alive player clockwise from the attacker's seat,
 * wrapping around the seat range. Nothing else picks a target — no mouse input,
 * no randomness — so every client resolves the same target from the same
 * snapshot. Returns `null` only when no other seat is alive.
 */
export function nextAliveBySeat<T extends { slot: number }>(
  seats: readonly T[],
  fromSlot: number,
  isAlive: (seat: T) => boolean,
): T | null {
  let chosen: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const seat of seats) {
    if (!isAlive(seat) || seat.slot === fromSlot) continue;
    const distance =
      (((seat.slot - fromSlot) % MAX_PRIVATE_PLAYERS) + MAX_PRIVATE_PLAYERS) % MAX_PRIVATE_PLAYERS;
    if (distance < bestDistance) {
      chosen = seat;
      bestDistance = distance;
    }
  }
  return chosen;
}

export interface MatchStanding {
  userId: string;
  /** Remaining health at the end of the match. */
  hp: number;
  damageDealt: number;
  /** Confirmed characters of completed spells; the live prefix is not counted here. */
  correctChars: number;
  eliminatedAt: number | null;
}

function compareSurvivors(a: MatchStanding, b: MatchStanding): number {
  if (a.hp !== b.hp) return b.hp - a.hp;
  if (a.damageDealt !== b.damageDealt) return b.damageDealt - a.damageDealt;
  return b.correctChars - a.correctChars;
}

/**
 * Final competition ranks (1, 1, 3) for one match.
 *
 * Survivors come first, ordered by remaining health, then damage dealt, then
 * confirmed characters. Anyone eliminated ranks behind every survivor, and
 * later eliminations rank higher: surviving longer is the only ordering rule
 * among the fallen. Players equal on their group's whole comparison key share a
 * rank; nothing else breaks a tie — not seat, not user id, not arrival order.
 */
export function survivalRanks(standings: readonly MatchStanding[]): Map<string, number> {
  const survivors = standings.filter((entry) => entry.eliminatedAt === null).sort(compareSurvivors);
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
    while (
      last + 1 < survivors.length &&
      compareSurvivors(survivors[last + 1], survivors[index]) === 0
    )
      last++;
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
