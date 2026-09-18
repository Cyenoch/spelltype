import { WS_CLOSE } from '../../shared/protocol';
import type { ReservationState } from '../../shared/protocol';
import type { RoomRow } from '../db/schema';
import { reservationIsLive } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeAllSockets } from './sockets';
import { deleteAllPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';

/**
 * Reservation state for matchmaking reconciliation, normalized for the clock:
 * `reserved` means a live pre-match reservation, `locked` means a match is
 * generating or running, and everything else (`none`, `cancelled`, `expired`)
 * holds no allocation, so a ticket can be dropped. A room id that was never
 * initialized reads as `none` rather than an error, and a reservation whose
 * deadline passed reads as `expired` even before the catch-up that cleans it
 * up has run. The shared database makes this a plain read for coordination.
 */
export function reservationStateOf(room: RoomRow | null, now: number): ReservationState {
  if (!room) return 'none';
  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    !reservationIsLive(room, now)
  )
    return 'expired';
  return room.reservation_state;
}

/**
 * Ends a live quick reservation: both seats freed, every socket told and then
 * closed. The decision is re-read under the caller's fence, so a reservation
 * the coordination layer already cancelled can never be overwritten by a stale
 * expiry, and a match that started meanwhile is never touched. The final
 * snapshot — carrying the reason — reaches the seats before their connections
 * close, exactly like the frame the old object sent. Returns whether this call
 * actually ended the reservation.
 */
export async function endReservation(
  scope: RoomScope,
  state: 'cancelled' | 'expired',
  message: string,
): Promise<boolean> {
  let ended = false;
  await scope.transact(async (tx) => {
    const room = await getRoom(tx, scope.roomId);
    if (!room || room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return;
    if (room.reservation_state !== 'reserved') return;
    await updateRoom(tx, scope.roomId, {
      reservation_state: state,
      reservation_expires_at: null,
      error: message,
    });
    ended = true;
  });
  if (!ended) return false;
  await pushSnapshots(scope);
  await scope.transact(async (tx) => deleteAllPlayers(tx, scope.roomId));
  closeAllSockets(scope.registry, WS_CLOSE.closed, state);
  return true;
}
