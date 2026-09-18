import { RESERVATION_TTL_MS } from '../../shared/protocol';
import type { Difficulty, MatchTicket, User } from '../../shared/protocol';
import { matchIsLive, queueStub, readReservation } from './rooms';
import type { CancelTarget, TicketRow } from './schema';
import type { MatchmakerScope } from './scope';
import {
  deleteTicket,
  isCurrentRequest,
  matchTicket,
  readTicket,
  refreshTicketExpiry,
  ticketFor,
} from './store';

/** Outcome of reconciling a matched ticket: keep it, drop it, or hand over to whoever changed it. */
export type MatchVerdict =
  | { kind: 'ticket'; ticket: MatchTicket }
  | { kind: 'dead' }
  | { kind: 'stale'; ticket: MatchTicket | null };

/**
 * Result of giving up an account's matchmaking. `heldRoomId` is set when a room still holds the
 * account's seat (a started match, or a reservation it refused to release): that seat cannot be
 * cancelled, so the account must stay matched to that room instead of being freed.
 */
export type CancelOutcome = {
  cancelled: boolean;
  heldRoomId: string | null;
};

/**
 * Reads the ready pairings for this account. The pairing row is never consumed here: it is already
 * durable in the queue, so a shard that restarts between claiming and answering simply reads it
 * again. A pairing that no longer belongs to the current request is released, which frees the room
 * for the other account instead of leaving a match that nobody was told about.
 */
export async function settle(
  scope: MatchmakerScope,
  userId: string,
  difficulty: Difficulty,
  requestId: string,
): Promise<MatchTicket | null> {
  const queue = queueStub(scope.env, difficulty);
  const claimed = await queue.claim(userId);
  if (claimed.length === 0) return null;
  const mine = claimed.find((entry) => entry.request_id === requestId) ?? null;
  let heldRoomId: string | null = null;
  for (const entry of claimed) {
    if (entry === mine) continue;
    heldRoomId = (await queue.release(entry.room_id, userId, entry.request_id)) ?? heldRoomId;
  }
  if (heldRoomId && isCurrentRequest(scope, userId, requestId)) {
    // An earlier pairing of this account still holds a room: keep that seat, add no entry.
    recordHeldSeat(scope, { user_id: userId, request_id: requestId, difficulty }, heldRoomId);
    return {
      state: 'matched',
      difficulty,
      roomId: heldRoomId,
      expiresAt: Date.now() + RESERVATION_TTL_MS,
    };
  }
  if (!mine) return null;
  const current = readTicket(scope, userId);
  if (
    current &&
    current.request_id === requestId &&
    current.state === 'matched' &&
    current.room_id === mine.room_id
  ) {
    // Another poll already recorded this pairing: answer it, never release a live room.
    return {
      state: 'matched',
      difficulty: current.difficulty,
      roomId: mine.room_id,
      expiresAt: current.expires_at,
    };
  }
  if (!current || current.request_id !== requestId || current.state !== 'waiting') {
    const heldId = await queue.release(mine.room_id, userId, mine.request_id);
    if (heldId && isCurrentRequest(scope, userId, requestId)) {
      recordHeldSeat(scope, { user_id: userId, request_id: requestId, difficulty }, heldId);
      return {
        state: 'matched',
        difficulty,
        roomId: heldId,
        expiresAt: Date.now() + RESERVATION_TTL_MS,
      };
    }
    return null;
  }
  matchTicket(scope, userId, requestId, mine.room_id, mine.expires_at, Date.now());
  await queue.leave(userId, requestId);
  return {
    state: 'matched',
    difficulty: current.difficulty,
    roomId: mine.room_id,
    expiresAt: mine.expires_at,
  };
}

/** Decides the fate of the account's matched ticket after the room has been consulted. */
export async function reconcileMatched(
  scope: MatchmakerScope,
  user: User,
  row: TicketRow,
): Promise<MatchVerdict> {
  const roomId = row.room_id;
  if (!roomId) {
    deleteTicket(scope, user.id, row.request_id);
    return { kind: 'dead' };
  }
  const reservation = await readReservation(scope.env, roomId);
  const current = readTicket(scope, user.id);
  if (!current || current.request_id !== row.request_id || current.state !== 'matched') {
    // The ticket changed while the reservation was being read: the changed ticket owns the answer.
    return { kind: 'stale', ticket: current ? ticketFor(current) : null };
  }
  if (reservation === 'locked' && !(await matchIsLive(scope.env, user, roomId))) {
    // The running match is over, so the seat no longer blocks a new one.
    deleteTicket(scope, user.id, row.request_id);
    return { kind: 'dead' };
  }
  if (reservation !== 'reserved' && reservation !== 'locked') {
    // Reservation cancelled, expired, or the room is gone: drop the stale ticket.
    deleteTicket(scope, user.id, row.request_id);
    return { kind: 'dead' };
  }
  const now = Date.now();
  const expiresAt = Math.max(current.expires_at, now + RESERVATION_TTL_MS);
  refreshTicketExpiry(scope, user.id, row.request_id, expiresAt, now);
  return {
    kind: 'ticket',
    ticket: { state: 'matched', difficulty: row.difficulty, roomId, expiresAt },
  };
}

/**
 * Confirms a cancellation with the queue, clearing the tombstone only once the queue has answered
 * for both the entry and any room it had already reserved.
 *
 * - queue confirmed, no live seat: the ticket is gone and the account is free.
 * - a room still holds the seat (a started match, or a reservation it refused to release): the
 *   account is kept matched to that room and the answer stays `false`.
 * - the queue could not be reached: the tombstone stays and the retry happens on the next alarm or
 *   poll, so the answer is never `true` while a seat may still exist.
 */
export async function finishCancel(
  scope: MatchmakerScope,
  row: CancelTarget,
): Promise<CancelOutcome> {
  let retained: string[];
  try {
    retained = await queueStub(scope.env, row.difficulty).abort(row.user_id, row.request_id);
  } catch (error) {
    console.error(
      'matchmaker: cancel cleanup failed',
      error instanceof Error ? error.message : error,
    );
    return { cancelled: false, heldRoomId: null };
  }
  const heldRoomId = retained[0] ?? null;
  if (heldRoomId) {
    recordHeldSeat(scope, row, heldRoomId);
    return { cancelled: false, heldRoomId };
  }
  deleteTicket(scope, row.user_id, row.request_id);
  return { cancelled: true, heldRoomId: null };
}

/** Keeps the account matched to a room that still holds its seat; the seat is not cancellable. */
function recordHeldSeat(scope: MatchmakerScope, row: CancelTarget, roomId: string): void {
  const now = Date.now();
  matchTicket(scope, row.user_id, row.request_id, roomId, now + RESERVATION_TTL_MS, now);
}
