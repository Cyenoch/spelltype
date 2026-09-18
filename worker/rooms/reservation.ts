import { WS_CLOSE } from '../../shared/protocol';
import type { ReservationState } from '../../shared/protocol';
import { MATCH_ACTIVE, reservationIsLive } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeAllSockets } from './sockets';
import { deleteAllPlayers, getPlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { scheduleAlarm } from './timers';

/**
 * Reservation state for matchmaking reconciliation. `reserved` means a live
 * pre-match reservation, `locked` means a match is generating or running, and
 * everything else (`none`, `cancelled`, `expired`) holds no allocation, so a
 * ticket can be dropped. A room id that was never initialized reads as `none`
 * rather than an error, and a reservation whose deadline passed reads as
 * `expired` even before the alarm that cleans it up has run.
 */
export async function reservationState(scope: RoomScope): Promise<ReservationState> {
  const room = getRoom(scope.sql);
  if (!room) return 'none';
  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    !reservationIsLive(room, Date.now())
  )
    return 'expired';
  return room.reservation_state;
}

/**
 * Releases this account's matchmaking allocation, if it still holds one.
 *
 * Idempotent by design: `false` means exactly one thing — a running match still
 * owns this account's seat, so the caller must keep the ticket. Everything else
 * (`true`) means the account now holds no live reservation, including a room id
 * that was never initialized, a seat the room no longer knows, a private room
 * with no matchmaking allocation, an already-terminated reservation and one
 * whose deadline passed. Callers must be the trusted matchmaker.
 */
export async function cancelReservation(scope: RoomScope, userId: string): Promise<boolean> {
  const room = getRoom(scope.sql);
  if (!room) return true;
  const seated = getPlayer(scope.sql, userId) !== null;
  if (MATCH_ACTIVE[room.phase] && seated) return false;
  if (room.mode !== 'quick' || room.reservation_state !== 'reserved') return true;
  if (!seated) return true;
  const live = reservationIsLive(room, Date.now());
  endReservation(
    scope,
    live ? 'cancelled' : 'expired',
    live ? '匹配已取消，请重新匹配。' : '匹配超时，请重新匹配。',
  );
  await scheduleAlarm(scope);
  return true;
}

/** Ends a live quick reservation: both seats freed, every socket told and closed. */
export function endReservation(
  scope: RoomScope,
  state: 'cancelled' | 'expired',
  message: string,
): void {
  const room = getRoom(scope.sql);
  if (!room) return;
  if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return;
  updateRoom(scope.sql, { reservation_state: state, reservation_expires_at: null, error: message });
  pushSnapshots(scope);
  deleteAllPlayers(scope.sql);
  closeAllSockets(scope, WS_CLOSE.closed, state);
}
