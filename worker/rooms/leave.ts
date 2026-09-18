import { finishMatch } from './match';
import { RoomRejection } from './rejection';
import { endReservation } from './reservation';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeUserSockets, reconcileHost } from './sockets';
import { scheduleAlarm } from './timers';
import { abandonedMatch, getDeparture, recordDeparture } from './storage/departures';
import { deletePlayer, getPlayer, listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import type { RoomRow } from './storage/schema';

/**
 * One account's explicit manual departure — the single routine behind the
 * `leave` lobby frame and the authenticated `POST /api/rooms/:id/leave` call.
 *
 * Leaving is a decision, not a drop: a closed browser, a network failure or a
 * refresh never reaches this routine, so every ordinary disconnect keeps its
 * reconnect semantics. What this routine commits is permanent for the account:
 * the seat is released, the connection is closed, and an abandoned live match
 * can never readmit the account — while everyone else's match and every result
 * row keep running untouched.
 *
 * Idempotent by design: a replayed leave after a committed one finds the
 * departure record and succeeds again, so an HTTP retry after a lost response
 * cannot fail. A room this account never belonged to is a `room:not_found`
 * refusal, not a silent success.
 *
 * The reply is written only after every statement here is durable: this module
 * awaits nothing external before its writes, so a caller that sees success can
 * trust the forfeit, the membership release and the matchmaker's next
 * reconciliation.
 */
export async function manualLeave(scope: RoomScope, userId: string): Promise<void> {
  const sql = scope.sql;
  const room = getRoom(sql);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  const player = getPlayer(sql, userId);

  if (!player) {
    // A committed earlier leave replays as success; anything else never sat here.
    if (getDeparture(sql, userId) !== null) return;
    throw new RoomRejection('room:not_found', '你不在这个房间中。');
  }

  const now = Date.now();
  if (room.mode === 'quick' && room.phase === 'lobby' && room.locked === 0) {
    if (room.reservation_state === 'reserved') {
      // Pre-match pairing: one side's departure cancels the whole reservation,
      // freeing both seats for the queue (existing reservation semantics).
      recordDeparture(sql, { userId, matchId: null, now });
      endReservation(scope, 'cancelled', '对手已离开，请重新匹配。');
      await scheduleAlarm(scope);
      return;
    }
    return openLobbyLeave(scope, userId, now);
  }
  if (room.phase === 'lobby' && room.locked === 0) return openLobbyLeave(scope, userId, now);
  if (room.phase === 'finished') return finishedLeave(scope, room, userId, now);
  return forfeit(scope, room, userId, now);
}

/** An open lobby holds no match: the seat is deleted and may be taken again by a fresh join. */
async function openLobbyLeave(scope: RoomScope, userId: string, now: number): Promise<void> {
  deletePlayer(scope.sql, userId);
  recordDeparture(scope.sql, { userId, matchId: null, now });
  closeUserSockets(scope, userId, 'left');
  reconcileHost(scope);
  pushSnapshots(scope);
  await scheduleAlarm(scope);
}

/**
 * A settled match's ranking is already durable; leaving it releases only the
 * connection and the entitlement, never a result row or a rank.
 */
async function finishedLeave(
  scope: RoomScope,
  room: RoomRow,
  userId: string,
  now: number,
): Promise<void> {
  recordDeparture(scope.sql, { userId, matchId: room.match_id, now });
  closeUserSockets(scope, userId, 'left');
  pushSnapshots(scope);
}

/**
 * A match is being formed or fought: the departure forfeits the seat.
 *
 * The leaver is set out of the combat (zero health at the departure instant), so
 * ranks and results keep a faithful order, and survivor rules decide the match
 * from there: in a duel the opponent's win is settled immediately, while a larger
 * table that still has rivals fights on. During generation or countdown the same
 * state is committed up front, so a delayed continuation can never resurrect the
 * abandoned seat into the match it follows.
 */
async function forfeit(
  scope: RoomScope,
  room: RoomRow,
  userId: string,
  now: number,
): Promise<void> {
  const matchId = room.match_id;
  if (matchId === null) {
    // Unreachable: a locked room always carries its match id. Refuse honestly
    // instead of guessing what an invariant violation means.
    throw new Error('room:leave_without_match');
  }
  if (abandonedMatch(scope.sql, userId, matchId)) {
    // Already forfeited this match (a replayed leave): only the connection is released.
    closeUserSockets(scope, userId, 'left');
    return;
  }
  recordDeparture(scope.sql, { userId, matchId, now });
  const player = getPlayer(scope.sql, userId);
  if (player === null) throw new Error('room:leave_seat_vanished');
  if (player.eliminated_at === null) updatePlayer(scope.sql, userId, { hp: 0, eliminated_at: now });
  // The seat stops pointing at any connection before the sockets close, so a
  // frame queued ahead of the close cannot act on a match this account left.
  updatePlayer(scope.sql, userId, { conn_id: null, slot_expires_at: null });
  closeUserSockets(scope, userId, 'left');
  reconcileHost(scope);

  if (room.phase === 'playing') {
    const alive = listPlayers(scope.sql).filter((row) => row.eliminated_at === null).length;
    if (alive <= 1) {
      // The forfeit decided the match: settle it now, exactly like a combat KO.
      await finishMatch(scope, 'elimination', now);
      return;
    }
  }
  pushSnapshots(scope);
  await scheduleAlarm(scope);
}
