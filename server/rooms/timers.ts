import { TIMED_PHASES } from './rules';
import type { RoomScope } from './scope';
import { listPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { readVolley } from './storage/volley';
import type { PlayerRow, RoomRow } from '../db/schema';

/**
 * The earliest durable deadline a room owes a wake-up for, plus the earliest
 * process-local one. Durable deadlines are persisted in `next_alarm_at` and
 * recovered at startup; session expiries live only in the socket registry, so
 * they die with the process exactly like the sessions' sockets do. An open
 * combat volley is durable: its batch boundary must fire even after a restart,
 * or accepted casts would never land. The generation attempt this engine is
 * awaiting is never a wake-up of its own — its continuation rearms the timer
 * when it settles.
 */
export function computeNextAlarm(
  room: RoomRow,
  players: readonly PlayerRow[],
  earliestSessionExpiry: number | null,
  volleyEndsAt: number | null,
  now: number,
  generationInFlight: string | null,
): { durable: number | null; memory: number | null } {
  const timers: number[] = [];
  if (
    room.phase === 'generating' &&
    room.generation_token !== null &&
    room.generation_token !== generationInFlight
  )
    timers.push(now);
  if (TIMED_PHASES[room.phase] && room.deadline > 0) timers.push(room.deadline);
  if (room.phase === 'playing' && volleyEndsAt !== null) timers.push(volleyEndsAt);
  if (room.reservation_state === 'reserved' && room.reservation_expires_at !== null)
    timers.push(room.reservation_expires_at);
  if (room.locked === 0 && room.phase === 'lobby') {
    for (const seat of players) {
      if (seat.slot_expires_at !== null) timers.push(seat.slot_expires_at);
    }
  }
  const durable = timers.length > 0 ? Math.min(...timers) : null;
  const memory =
    earliestSessionExpiry !== null
      ? durable !== null
        ? Math.min(durable, earliestSessionExpiry)
        : earliestSessionExpiry
      : durable;
  return { durable, memory };
}

/** The earliest session expiry among the room's open sockets, if any. */
export function earliestSessionExpiry(scope: RoomScope, now: number): number | null {
  let earliest: number | null = null;
  for (const socket of scope.registry.list()) {
    if (socket.readyState !== 1) continue;
    const meta = scope.registry.metaOf(socket);
    if (meta && meta.sessionExpires > now && (earliest === null || meta.sessionExpires < earliest))
      earliest = meta.sessionExpires;
  }
  return earliest;
}

/**
 * Recomputes the room's timers from persisted state and hands the memory timer
 * to the engine. `next_alarm_at` is a durable hint — deadlines themselves live
 * in the room row — so the write is best-effort bookkeeping, and a stale value
 * only costs an extra harmless wake-up after a restart.
 */
export async function armRoom(
  scope: RoomScope,
  setTimer: (when: number | null) => void,
): Promise<void> {
  const now = scope.now();
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) {
    await scope.transact(async (tx) => updateRoom(tx, scope.roomId, { next_alarm_at: null }));
    setTimer(null);
    return;
  }
  const players = await listPlayers(scope.db, scope.roomId);
  const volley = room.phase === 'playing' ? await readVolley(scope.db, scope.roomId) : null;
  const { durable, memory } = computeNextAlarm(
    room,
    players,
    earliestSessionExpiry(scope, now),
    volley?.endsAt ?? null,
    now,
    scope.inFlightGeneration,
  );
  if (room.next_alarm_at !== durable) {
    await scope.transact(async (tx) => updateRoom(tx, scope.roomId, { next_alarm_at: durable }));
  }
  setTimer(memory === null ? null : Math.max(now, memory));
}
