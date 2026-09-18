import type { Difficulty, MatchTicket } from '../../shared/protocol';
import type { TicketRow } from './schema';
import type { MatchmakerScope } from './scope';

/**
 * The account's single ticket: the record that makes "one queue seat per account, across
 * difficulties" enforceable. Everything that reads or writes it lives here, so the coordinator's
 * decisions never depend on a second copy of the row.
 */
export function readTicket(scope: MatchmakerScope, userId: string): TicketRow | null {
  return (
    scope.sql.exec<TicketRow>('SELECT * FROM ticket WHERE user_id = ?', userId).toArray()[0] ?? null
  );
}

export function deleteTicket(scope: MatchmakerScope, userId: string, requestId: string): void {
  scope.sql.exec('DELETE FROM ticket WHERE user_id = ? AND request_id = ?', userId, requestId);
}

/**
 * Writes the account's ticket as waiting, replacing whatever request was stored before. This is the
 * first statement of a poll, immediately after the caller's read: no await separates "this account has
 * no ticket" from "this account waits with this request".
 */
export function startWaitingTicket(
  scope: MatchmakerScope,
  row: {
    userId: string;
    username: string;
    requestId: string;
    difficulty: Difficulty;
    expiresAt: number;
    now: number;
  },
): void {
  scope.sql.exec(
    "INSERT INTO ticket (user_id, username, request_id, difficulty, state, room_id, expires_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', NULL, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, request_id = excluded.request_id, difficulty = excluded.difficulty, state = 'waiting', room_id = NULL, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
    row.userId,
    row.username,
    row.requestId,
    row.difficulty,
    row.expiresAt,
    row.now,
  );
}

/**
 * Tombstones the request synchronously: from this instant on, no pairing may be published for it, and
 * the tombstone survives until the queue confirms.
 */
export function tombstoneTicket(scope: MatchmakerScope, userId: string, requestId: string): void {
  scope.sql.exec(
    "UPDATE ticket SET state = 'cancelling', updated_at = ? WHERE user_id = ? AND request_id = ?",
    Date.now(),
    userId,
    requestId,
  );
}

/** Binds the account's ticket to the room that now holds its seat. */
export function matchTicket(
  scope: MatchmakerScope,
  userId: string,
  requestId: string,
  roomId: string,
  expiresAt: number,
  now: number,
): void {
  scope.sql.exec(
    "UPDATE ticket SET state = 'matched', room_id = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND request_id = ?",
    roomId,
    expiresAt,
    now,
    userId,
    requestId,
  );
}

export function refreshTicketExpiry(
  scope: MatchmakerScope,
  userId: string,
  requestId: string,
  expiresAt: number,
  now: number,
): void {
  scope.sql.exec(
    'UPDATE ticket SET expires_at = ?, updated_at = ? WHERE user_id = ? AND request_id = ?',
    expiresAt,
    now,
    userId,
    requestId,
  );
}

/** Answers with the account's current ticket as it stands; never invents a new request. */
export function ticketFor(row: TicketRow): MatchTicket {
  if (row.state === 'matched' && row.room_id) {
    return {
      state: 'matched',
      difficulty: row.difficulty,
      roomId: row.room_id,
      expiresAt: row.expires_at,
    };
  }
  return { state: 'waiting', difficulty: row.difficulty, expiresAt: row.expires_at };
}

export function isCurrentWaiting(
  scope: MatchmakerScope,
  userId: string,
  requestId: string,
): boolean {
  const row = readTicket(scope, userId);
  return row !== null && row.state === 'waiting' && row.request_id === requestId;
}

/** True while this request is still the account's ticket, in either direction of the flow. */
export function isCurrentRequest(
  scope: MatchmakerScope,
  userId: string,
  requestId: string,
): boolean {
  const row = readTicket(scope, userId);
  return row !== null && row.request_id === requestId && row.state !== 'cancelling';
}
