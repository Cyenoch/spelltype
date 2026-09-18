import { and, asc, eq, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { players } from '../../db/schema';
import type { PlayerRow } from '../../db/schema';
import type { RoomQuery } from './query';
import { INITIAL_HEALTH, MAX_PRIVATE_PLAYERS } from '../../../shared/protocol';

/**
 * Columns a seat patch may name; a seat's identity and join time are fixed once it is taken.
 * The `input_*`/`draft_epoch` columns are the input gate's per-seat eligibility and metrics —
 * written by combat judging, the countdown transition and the match reset, never injected.
 */
const PLAYER_PATCH_COLUMNS = [
  'slot',
  'slot_expires_at',
  'conn_id',
  'seated',
  'ready',
  'progress',
  'spell_index',
  'spells_cast',
  'hp',
  'max_hp',
  'damage_dealt',
  'correct_chars',
  'attempt_total',
  'error_total',
  'cpm',
  'last_input',
  'eliminated_at',
  'input_opened_at',
  'input_not_before',
  'draft_epoch',
  'input_reset_reason',
  'input_sampled',
  'input_gate_hits',
  'input_recoveries',
  'input_min_completion_ratio',
  'input_overloads',
  'input_recovered_completions',
  'input_recovery_departures',
] as const;

export type PlayerPatch = Partial<Pick<PlayerRow, (typeof PLAYER_PATCH_COLUMNS)[number]>>;

/** Every seat of one room, in stable seat order. */
export async function listPlayers(db: RoomQuery, roomId: string): Promise<PlayerRow[]> {
  return db.select().from(players).where(eq(players.room_id, roomId)).orderBy(asc(players.slot));
}

export async function getPlayer(
  db: RoomQuery,
  roomId: string,
  userId: string,
): Promise<PlayerRow | null> {
  const rows = await db
    .select()
    .from(players)
    .where(and(eq(players.room_id, roomId), eq(players.user_id, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countPlayers(db: RoomQuery, roomId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(players)
    .where(eq(players.room_id, roomId));
  return rows[0]?.total ?? 0;
}

/**
 * Creates a seat in the lowest free slot. Returns the seat, or `null` when the table is full.
 * The insert is a no-op for a seat this account already holds, so a retried join never errors.
 */
export async function insertPlayer(
  db: RoomQuery,
  roomId: string,
  player: { userId: string; username: string; slotExpiresAt: number | null; now: number },
): Promise<PlayerRow | null> {
  const taken = await db
    .select({ slot: players.slot })
    .from(players)
    .where(eq(players.room_id, roomId))
    .orderBy(asc(players.slot));
  const used = new Set(taken.map((row) => row.slot));
  let slot: number | null = null;
  for (let candidate = 0; candidate < MAX_PRIVATE_PLAYERS; candidate++) {
    if (!used.has(candidate)) {
      slot = candidate;
      break;
    }
  }
  if (slot === null) return null;
  await db
    .insert(players)
    .values({
      room_id: roomId,
      user_id: player.userId,
      username: player.username,
      slot,
      joined_at: player.now,
      slot_expires_at: player.slotExpiresAt,
    })
    .onConflictDoNothing();
  return getPlayer(db, roomId, player.userId);
}

/**
 * Applies a patch over the known columns only, so a caller can never inject a column. Fields left
 * `undefined` are cleared to `null`, exactly like the transitions that reset them.
 */
export async function updatePlayer(
  db: RoomQuery,
  roomId: string,
  userId: string,
  patch: PlayerPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) =>
    (PLAYER_PATCH_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const values: Record<string, unknown> = {};
  for (const [key, value] of entries) values[key] = value ?? null;
  await db
    .update(players)
    .set(values)
    .where(and(eq(players.room_id, roomId), eq(players.user_id, userId)));
}

export async function deletePlayer(db: RoomQuery, roomId: string, userId: string): Promise<void> {
  await db.delete(players).where(and(eq(players.room_id, roomId), eq(players.user_id, userId)));
}

export async function deleteAllPlayers(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(players).where(eq(players.room_id, roomId));
}

/** Releases seats that were reserved for a match but never used. */
export async function deleteReservedSeats(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(players).where(and(eq(players.room_id, roomId), eq(players.seated, 0)));
}

/**
 * Re-arms seat expiry when the room is back in an open lobby: seats whose player
 * is not connected now expire, connected seats do not. Without this a seat that
 * was held through a finished match (expiry cleared while the roster was locked)
 * would block the next start forever.
 */
export async function armLobbySeatExpiry(
  db: RoomQuery,
  roomId: string,
  connectedIds: readonly string[],
  expiresAt: number,
): Promise<void> {
  if (connectedIds.length === 0) {
    await db.update(players).set({ slot_expires_at: expiresAt }).where(eq(players.room_id, roomId));
    return;
  }
  await db
    .update(players)
    .set({ slot_expires_at: expiresAt })
    .where(and(eq(players.room_id, roomId), notInArray(players.user_id, [...connectedIds])));
  await db
    .update(players)
    .set({ slot_expires_at: null })
    .where(and(eq(players.room_id, roomId), inArray(players.user_id, [...connectedIds])));
}

/** Releases every expired seat; returns how many seats were freed. */
export async function expireSeats(db: RoomQuery, roomId: string, now: number): Promise<number> {
  const removed = await db
    .delete(players)
    .where(
      and(
        eq(players.room_id, roomId),
        isNotNull(players.slot_expires_at),
        lte(players.slot_expires_at, now),
      ),
    )
    .returning({ userId: players.user_id });
  return removed.length;
}

/**
 * Puts every seat back to a fresh pre-match state: full health, first spell,
 * empty draft, zero aggregates and cleared input eligibility. Called when a
 * match starts, so a previous match's numbers — gate hits, recoveries,
 * overloads and any lingering eligibility — can never leak into the next one.
 */
export async function resetPlayersForMatch(db: RoomQuery, roomId: string): Promise<void> {
  await db
    .update(players)
    .set({
      progress: 0,
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
      max_hp: INITIAL_HEALTH,
      damage_dealt: 0,
      correct_chars: 0,
      attempt_total: 0,
      error_total: 0,
      cpm: 0,
      last_input: '',
      eliminated_at: null,
      input_opened_at: null,
      input_not_before: null,
      draft_epoch: 0,
      input_reset_reason: null,
      input_sampled: 0,
      input_gate_hits: 0,
      input_recoveries: 0,
      input_min_completion_ratio: null,
      input_overloads: 0,
      input_recovered_completions: 0,
      input_recovery_departures: 0,
    })
    .where(eq(players.room_id, roomId));
}

/** Clears readiness for a fresh lobby; a failed generation keeps it. */
export async function clearReady(db: RoomQuery, roomId: string): Promise<void> {
  await db.update(players).set({ ready: 0 }).where(eq(players.room_id, roomId));
}
