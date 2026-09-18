import { queueShardName } from '../ids';
import type { Env } from '../env';
import type { Difficulty, ReservationState, User } from '../../shared/protocol';

/** The queue shard for one difficulty: the only place a pairing is ever decided. */
export function queueStub(env: Env, difficulty: Difficulty) {
  return env.MATCHMAKER.get(env.MATCHMAKER.idFromName(queueShardName(difficulty)));
}

/** The room that may hold an account's seat. */
export function roomStub(env: Env, roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

/**
 * Reservation state for cleanup decisions; an unreachable room is reported as such, never guessed.
 * A room that was never initialized answers `none` rather than failing.
 */
export async function probeReservation(
  env: Env,
  roomId: string,
): Promise<ReservationState | 'unreachable'> {
  try {
    return await roomStub(env, roomId).reservationState();
  } catch (error) {
    console.warn(
      'matchmaker: reservation state unavailable',
      error instanceof Error ? error.message : error,
    );
    return 'unreachable';
  }
}

/**
 * Reservation state for ticket decisions: an unreachable room keeps the ticket rather than dropping a
 * seat that may still be live.
 */
export async function readReservation(env: Env, roomId: string): Promise<ReservationState> {
  try {
    return await roomStub(env, roomId).reservationState();
  } catch (error) {
    console.error(
      'matchmaker: reservationState failed',
      error instanceof Error ? error.message : error,
    );
    return 'reserved';
  }
}

/**
 * True when a room rejection says the room, or this account's seat in it, is gone.
 *
 * A room throws `RoomRejection` with a machine-readable `code`. Over Durable Object RPC that arrives
 * as a reconstructed error: enhanced error serialization preserves `name`, `message` and serializable
 * own properties, but never the class identity — so the documented fields are read here, and anything
 * else (including a transport failure) is not a "gone" answer.
 */
function roomSeatGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const refusal = error as { name?: unknown; code?: unknown };
  return (
    refusal.name === 'RoomRejection' &&
    (refusal.code === 'room:not_found' || refusal.code === 'room:reservation_gone')
  );
}

/** The room's own answer to "does this account's locked seat still belong to a match?" */
export async function matchIsLive(env: Env, user: User, roomId: string): Promise<boolean> {
  try {
    const snapshot = await roomStub(env, roomId).snapshot(user);
    return snapshot.phase !== 'finished';
  } catch (error) {
    if (roomSeatGone(error)) return false;
    // An unreachable room keeps the seat: the safe direction is refusing a new match, never handing
    // out a duplicate one.
    console.warn(
      'matchmaker: match state unavailable, keeping the seat',
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}
