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
import { readVolley } from './storage/volley';
import { advanceCombat } from './volleys';

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
 * Due combat is resolved before leaving can change survival. The reply follows
 * the durable departure marker, so a caller that sees success can trust the
 * forfeit, membership release and matchmaker reconciliation.
 */
export async function manualLeave(scope: RoomScope, userId: string): Promise<void> {
  const sql = scope.sql;
  let room = getRoom(sql);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  const player = getPlayer(sql, userId);

  if (!player) {
    // A committed earlier leave replays as success; anything else never sat here.
    if (getDeparture(sql, userId) !== null) return;
    throw new RoomRejection('room:not_found', '你不在这个房间中。');
  }

  const now = Date.now();
  if (room.phase === 'playing') {
    await advanceCombat(scope, now);
    room = getRoom(sql)!;
  }
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
 * from there: a duel ends after any already committed volley lands; a larger
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
  // The departure is one committed block: the abandonment marker, the combat
  // exit, the recovery-departure metric and the seat losing its connection
  // commit together or not at all — a crash leaves the seat either fully in
  // the match or fully out of it, never eliminated but still connected.
  scope.transactionSync(() => {
    recordDeparture(scope.sql, { userId, matchId, now });
    const player = getPlayer(scope.sql, userId);
    if (player === null) throw new Error('room:leave_seat_vanished');
    if (player.eliminated_at === null) {
      updatePlayer(scope.sql, userId, {
        hp: 0,
        eliminated_at: now,
        // Only a live playing epoch can be abandoned mid-spell: a committed
        // cast, a seat lost in combat or an unstarted match has no uncompleted
        // epoch to count.
        input_recovery_departures:
          player.input_recovery_departures +
          Number(room.phase === 'playing' && player.draft_epoch > 0),
      });
    }
    // The seat stops pointing at any connection before the sockets close, so a
    // frame queued ahead of the close cannot act on a match this account left.
    updatePlayer(scope.sql, userId, { conn_id: null, slot_expires_at: null });
  });
  closeUserSockets(scope, userId, 'left');
  reconcileHost(scope);

  if (room.phase === 'playing') {
    const alive = listPlayers(scope.sql).filter((row) => row.eliminated_at === null).length;
    if (alive <= 1 && readVolley(scope.sql) === null) {
      // A committed cast remains valid even if its caster has just forfeited.
      await finishMatch(scope, 'elimination', now);
      return;
    }
  }
  pushSnapshots(scope);
  await scheduleAlarm(scope);
}
