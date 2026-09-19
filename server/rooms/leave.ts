import type { RoomRow } from '../db/schema';
import { finishMatchTx } from './match';
import { RoomRejection } from './rejection';
import { endReservation } from './reservation';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeUserSockets, reconcileHost } from './sockets';
import { abandonedMatch, getDeparture, recordDeparture } from './storage/departures';
import { deletePlayer, getPlayer, listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readVolley } from './storage/volley';
import { advanceCombat } from './volleys';

/**
 * One account's explicit manual departure — the single routine behind the
 * `leave` lobby frame and the authenticated room leave endpoint.
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
  let room = await getRoom(scope.db, scope.roomId);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  const player = await getPlayer(scope.db, scope.roomId, userId);

  if (!player) {
    // A committed earlier leave replays as success; anything else never sat here.
    if ((await getDeparture(scope.db, scope.roomId, userId)) !== null) return;
    throw new RoomRejection('room:not_found', '你不在这个房间中。');
  }

  const now = scope.now();
  if (room.phase === 'playing') {
    // The clock or an accepted batch beat the leave: settle it at its persisted
    // boundary first, so the departure can neither extend the match past its
    // single deadline nor reorder the ranking the batch already decided.
    while (await advanceCombat(scope, now)) {
      // Drain earlier synthetic actions and their batches before committing the departure.
    }
    room = (await getRoom(scope.db, scope.roomId))!;
  }
  if (room.mode === 'quick' && room.phase === 'lobby' && room.locked === 0) {
    if (room.reservation_state === 'reserved') {
      // Pre-match pairing: one side's departure cancels the whole reservation,
      // freeing both seats for the queue (existing reservation semantics).
      await scope.transact(async (tx) =>
        recordDeparture(tx, scope.roomId, { userId, matchId: null, now }),
      );
      await endReservation(scope, 'cancelled', '对手已离开，请重新匹配。');
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
  await scope.transact(async (tx) => {
    await deletePlayer(tx, scope.roomId, userId);
    await recordDeparture(tx, scope.roomId, { userId, matchId: null, now });
    await reconcileHost(tx, scope.roomId, scope.registry);
  });
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
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
  await scope.transact(async (tx) =>
    recordDeparture(tx, scope.roomId, { userId, matchId: room.match_id, now }),
  );
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
}

/**
 * A match is being formed or fought: the departure forfeits the seat.
 *
 * The leaver is set out of the combat (zero health at the departure instant), so
 * ranks and results keep a faithful order, and survivor rules decide the match
 * from there: a duel ends after any already committed volley lands; a larger
 * table that still has rivals fights on. During generation or countdown the same
 * state is committed up front, so a delayed continuation can never resurrect the
 * abandoned seat into the match it follows. A forfeit that decides a live duel
 * settles the match in the same transaction — the elimination and the history
 * rows commit together.
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
  if (await abandonedMatch(scope.db, scope.roomId, userId, matchId)) {
    // Already forfeited this match (a replayed leave): only the connection is released.
    closeUserSockets(scope.registry, userId, 'left');
    return;
  }
  // The departure is one committed block: the abandonment marker, the combat
  // exit, the recovery-departure metric and the seat losing its connection
  // commit together or not at all — a crash leaves the seat either fully in
  // the match or fully out of it, never eliminated but still connected.
  await scope.transact(async (tx) => {
    const fresh = await getRoom(tx, scope.roomId);
    if (!fresh || fresh.match_id !== matchId) throw new Error('room:leave_match_changed');
    await recordDeparture(tx, scope.roomId, { userId, matchId, now });
    const player = await getPlayer(tx, scope.roomId, userId);
    if (player === null) throw new Error('room:leave_seat_vanished');
    if (player.eliminated_at === null) {
      await updatePlayer(tx, scope.roomId, userId, {
        hp: 0,
        eliminated_at: now,
        // Only a live playing epoch can be abandoned mid-spell: a committed
        // cast, a seat lost in combat or an unstarted match has no uncompleted
        // epoch to count.
        input_recovery_departures:
          player.input_recovery_departures +
          Number(fresh.phase === 'playing' && player.draft_epoch > 0),
      });
    }
    // The seat stops pointing at any connection before the sockets close, so a
    // frame queued ahead of the close cannot act on a match this account left.
    await updatePlayer(tx, scope.roomId, userId, { conn_id: null, slot_expires_at: null });
    await reconcileHost(tx, scope.roomId, scope.registry);
    if (fresh.phase === 'playing') {
      const alive = (await listPlayers(tx, scope.roomId)).filter(
        (row) => row.eliminated_at === null,
      ).length;
      // A committed cast remains valid even if its caster has just forfeited:
      // while a window is open the match waits for it to land, exactly like the
      // timer would — settling under it would drop the caster's own commitment.
      if (alive <= 1 && (await readVolley(tx, scope.roomId)) === null) {
        // The forfeit decided the match: settle it now, exactly like a combat KO.
        await finishMatchTx(tx, scope.roomId, 'elimination', now);
      }
    }
  });
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
}
