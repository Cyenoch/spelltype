import { eq } from 'drizzle-orm';
import { rooms, players } from '../../db/schema';
import type { RoomRow } from '../../db/schema';
import type { RoomQuery } from './query';
import type { QueryDatabase } from '../../db';
import type { RoomInit } from '../../../shared/protocol';
import { roomInitSchema } from '../../../shared/validation';
import { RESERVATION_TTL_MS } from '../../../shared/protocol';
import { SEAT_TTL_MS } from '../rules';

/**
 * Columns a room patch may name; identity and creation stamps are fixed once
 * the room exists. `next_alarm_at` is a runtime-owned hint the runtime may
 * update.
 */
const ROOM_PATCH_COLUMNS = [
  'host_id',
  'phase',
  'deadline',
  'started_at',
  'ended_at',
  'end_reason',
  'match_id',
  'spell_book',
  'events_json',
  'event_seq',
  'error',
  'generation_token',
  'generation_claim',
  'generation_seq',
  'reservation_state',
  'reservation_expires_at',
  'locked',
  'input_policy_version',
  'input_policy_mode',
  'input_min_ms_per_code_point',
  'opponent_kind',
  'ghost_id',
  'opponent_next_at',
  'persistence',
  'persist_attempts',
  'persist_retry_at',
  'next_alarm_at',
] as const;

export type RoomPatch = Partial<Pick<RoomRow, (typeof ROOM_PATCH_COLUMNS)[number]>>;

/** Reads the room's one row, or `null` when no such room exists. */
export async function getRoom(db: RoomQuery, roomId: string): Promise<RoomRow | null> {
  const rows = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Applies a patch over the known columns only, so a caller can never inject a column and every
 * write touches `updated_at`. Fields left `undefined` are cleared to `null`, matching the old
 * patch semantics where a transition explicitly resets what it no longer means.
 */
export async function updateRoom(db: RoomQuery, roomId: string, patch: RoomPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) =>
    (ROOM_PATCH_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const values: Record<string, unknown> = {};
  for (const [key, value] of entries) values[key] = value ?? null;
  await db
    .update(rooms)
    .set({ ...values, updated_at: Date.now() })
    .where(eq(rooms.id, roomId));
}

/**
 * Creates the room and its initial roster inside the caller's transaction.
 *
 * This is the seam the matchmaker calls to pair a quick match and the one the
 * private-room flow uses: it writes the room row and every reserved seat, and
 * it takes no admission lock of its own — the caller's transaction already
 * holds the runtime_control admission gate — and it starts no runtime. A room
 * row that already exists with the same shape is an idempotent replay, matching
 * the old object-room contract; any other pre-existing row is a caller bug.
 *
 * All persisted state is written before the transaction can commit, so a
 * later wake-up can never observe a half-created room.
 */
export async function createRoom(tx: QueryDatabase, init: RoomInit): Promise<void> {
  const parsed = roomInitSchema.safeParse(init);
  if (!parsed.success) {
    throw new Error(`room:invalid_init:${parsed.error.issues[0]?.path.join('.') || 'shape'}`);
  }
  const { id, host, theme, mode, reserved } = parsed.data;
  const existing = await getRoom(tx, id);
  if (existing) {
    if (existing.mode !== mode) throw new Error('room:already_initialized');
    return;
  }
  const now = Date.now();

  // The host legitimately appears in `reserved` for quick rooms, so the host
  // is not counted twice; anything else duplicated is rejected by the schema.
  const roster = [host, ...(reserved ?? []).filter((entry) => entry.id !== host.id)];
  const seatExpiresAt = mode === 'quick' ? now + RESERVATION_TTL_MS : now + SEAT_TTL_MS;
  const reservationExpiresAt = mode === 'quick' ? now + RESERVATION_TTL_MS : null;

  await tx.insert(rooms).values({
    id,
    host_id: host.id,
    mode,
    theme,
    // Every room is hard: no request can choose a difficulty any more.
    difficulty: 'hard',
    phase: 'lobby',
    deadline: 0,
    events_json: '[]',
    event_seq: 0,
    generation_seq: 0,
    reservation_state: mode === 'quick' ? 'reserved' : 'none',
    reservation_expires_at: reservationExpiresAt,
    locked: 0,
    persistence: 'idle',
    persist_attempts: 0,
    // A fresh lobby always owes a wake-up: quick reservations expire, and
    // private lobby seats expire when their holders go idle.
    next_alarm_at: reservationExpiresAt ?? seatExpiresAt,
    created_at: now,
    updated_at: now,
  });
  for (const [slot, entry] of roster.entries()) {
    await tx.insert(players).values({
      room_id: id,
      user_id: entry.id,
      username: entry.username,
      slot,
      joined_at: now,
      slot_expires_at: seatExpiresAt,
    });
  }
}
