import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DAMAGE_PER_CHARACTER, INITIAL_HEALTH, WS_PROTOCOL, type Spell } from '../shared/protocol';
import { elementSchema } from '../shared/validation';
import type { QueryDatabase } from './db';
import { ghostCasts, ghosts } from './db/schema';
import type { GhostRow, PlayerRow, ReplayCast, RoomRow } from './db/schema';
import { roomPolicyValid } from './rooms/input-gate';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from './rooms/rules';
import { charCount, inputNotBefore, spellAt } from './scoring';

export type { GhostRow, ReplayCast } from './db/schema';

/**
 * Fingerprint of every rule a recorded trace replays under: the wire spell shape, the input
 * floor the pacing was judged against, and the health/damage constants the casts were scored
 * by. Selection serves only the current fingerprint, so a protocol or rules bump invalidates
 * recorded ghosts without rewriting them — they simply stop being chosen.
 */
export const GHOST_RULES_VERSION = [
  'ghosts.v1',
  WS_PROTOCOL,
  INPUT_POLICY_VERSION,
  String(INPUT_MIN_MS_PER_CODE_POINT),
  String(INITIAL_HEALTH),
  String(DAMAGE_PER_CHARACTER),
].join('+');

/** Selection scans only this many newest compatible ghosts, never the whole table. */
const SELECTION_POOL = 50;

/**
 * Reads one ghost by id, or `null` when no such ghost — or only an incompatible recording —
 * exists. Safe to invoke per due cast: a primary-key lookup plus the version filter, with no
 * payload decoding beyond what the caller needs anyway.
 */
export async function getGhost(db: QueryDatabase, id: string): Promise<GhostRow | null> {
  const rows = await db
    .select()
    .from(ghosts)
    .where(and(eq(ghosts.id, id), eq(ghosts.rules_version, GHOST_RULES_VERSION)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Picks a recorded opponent for the given account: newest-first over a bounded, indexed pool of
 * current-compatible ghosts, never the caller's own recordings, then uniformly at random within
 * that pool. The pool query reads candidate ids only, so the one chosen row's book and cast
 * payloads are decoded once, for the ghost actually served. `null` when nothing qualifies — the
 * caller falls back to a Bot instead.
 */
export async function chooseGhost(tx: QueryDatabase, userId: string): Promise<GhostRow | null> {
  const candidates = await tx
    .select({ id: ghosts.id })
    .from(ghosts)
    .where(and(eq(ghosts.rules_version, GHOST_RULES_VERSION), ne(ghosts.source_user_id, userId)))
    .orderBy(desc(ghosts.created_at), ghosts.id)
    .limit(SELECTION_POOL);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return chosen === undefined ? null : getGhost(tx, chosen.id);
}

/**
 * Records one accepted cast of a live human match inside the caller's accepted-cast transaction.
 * `player` is the seat row before its cursor advances — `player.spell_index` is the cast's own
 * book cursor — and `now` the accepted completion's absolute ms, stored as an offset from the
 * match's `started_at`. Ghost and bot rooms record nothing, and a replayed acceptance is
 * absorbed by the cast's primary key instead of failing the cast.
 */
export async function recordCastTx(
  tx: QueryDatabase,
  room: RoomRow,
  player: PlayerRow,
  now: number,
): Promise<void> {
  if (room.opponent_kind !== 'human') return;
  if (room.match_id === null || room.started_at === null) return;
  await tx
    .insert(ghostCasts)
    .values({
      room_id: room.id,
      match_id: room.match_id,
      user_id: player.user_id,
      spell_index: player.spell_index,
      at: now - room.started_at,
    })
    .onConflictDoNothing();
}

/**
 * Archives the finished match's human traces as immutable ghosts and drops the room's temporary
 * cast rows, all inside the caller's finish transaction. Every human seat whose trace qualifies
 * becomes its own ghost; a trace that fails any check is skipped, never half-kept, and its rows
 * are deleted with the rest so nothing non-qualifying lingers. Ghost and bot rooms recorded
 * nothing, so they only pay the cleanup delete.
 */
export async function publishGhostsTx(
  tx: QueryDatabase,
  room: RoomRow,
  players: readonly PlayerRow[],
): Promise<void> {
  const matchId = room.match_id;
  const startedAt = room.started_at;
  // Only a human room under exactly the policy ghosts replay under — current version, current
  // floor — can produce a trustworthy trace; anything else only pays the cleanup delete.
  if (
    room.opponent_kind === 'human' &&
    matchId !== null &&
    startedAt !== null &&
    roomPolicyValid(room) &&
    room.input_policy_version === INPUT_POLICY_VERSION &&
    room.input_min_ms_per_code_point === INPUT_MIN_MS_PER_CODE_POINT
  ) {
    const book = archiveBook(room);
    if (book !== null) {
      for (const player of players) {
        await publishSeatTx(tx, room, player, book, matchId, startedAt);
      }
    }
  }
  await tx.delete(ghostCasts).where(eq(ghostCasts.room_id, room.id));
}

/**
 * Decodes the room's immutable source book, refusing anything but a non-empty array of complete
 * spells: a trace replays against exactly the book it was typed on, and an archive row is built
 * once — never repaired later.
 */
function archiveBook(room: RoomRow): Spell[] | null {
  if (room.spell_book === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(room.spell_book);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const spell of parsed) {
    if (typeof spell !== 'object' || spell === null) return null;
    const entry = spell as Record<string, unknown>;
    if (
      typeof entry.name !== 'string' ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0 ||
      typeof entry.translation !== 'string' ||
      !elementSchema.safeParse(entry.element).success
    ) {
      return null;
    }
  }
  return parsed as Spell[];
}

/**
 * Publishes one seat's trace when it qualifies: the seat must have dealt at least one full
 * opponent's health of actual damage, and its recorded casts must be the complete contiguous
 * book prefix, paced no faster than the current input floor allows, and bounded by the match's
 * own clock. Any failed check silently skips the seat.
 */
async function publishSeatTx(
  tx: QueryDatabase,
  room: RoomRow,
  player: PlayerRow,
  book: Spell[],
  matchId: string,
  startedAt: number,
): Promise<void> {
  if (!(player.damage_dealt >= INITIAL_HEALTH)) return;
  const rows = await tx
    .select({ spell_index: ghostCasts.spell_index, at: ghostCasts.at })
    .from(ghostCasts)
    .where(and(eq(ghostCasts.match_id, matchId), eq(ghostCasts.user_id, player.user_id)))
    .orderBy(asc(ghostCasts.spell_index));
  if (rows.length === 0 || rows.length !== player.spells_cast) return;
  // The match's own clock bounds the trace: a fallen seat stopped at its elimination, a
  // survivor at the whistle. Damage past that bound is a corrupted trace, not a fast one.
  const latestAt = (player.eliminated_at ?? room.deadline) - startedAt;
  const casts: ReplayCast[] = [];
  let openedAt = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const spell = spellAt(book, index);
    if (row === undefined || row.spell_index !== index || spell === null) return;
    let earliest: number;
    try {
      earliest = inputNotBefore(charCount(spell.text), openedAt, INPUT_MIN_MS_PER_CODE_POINT);
    } catch {
      return;
    }
    if (row.at < earliest || row.at > latestAt) return;
    casts.push({ at: row.at, spellIndex: row.spell_index });
    openedAt = row.at;
  }
  await tx.insert(ghosts).values({
    id: randomUUID(),
    source_user_id: player.user_id,
    theme: room.theme,
    book,
    casts,
    rules_version: GHOST_RULES_VERSION,
    created_at: Date.now(),
  });
}
