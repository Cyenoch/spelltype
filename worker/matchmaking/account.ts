import { QUEUE_ENTRY_TTL_MS } from '../../shared/protocol';
import type { MatchCancelResult, MatchTicket, User } from '../../shared/protocol';
import { finishCancel, reconcileMatched, settle } from './reconcile';
import { MatchRejection } from './rejection';
import { matchIsLive, queueStub, readReservation, roomStub } from './rooms';
import { armAlarm } from './scope';
import type { MatchmakerScope } from './scope';
import type { TicketRow } from './schema';
import {
  deleteTicket,
  isCurrentWaiting,
  readTicket,
  startWaitingTicket,
  ticketFor,
  tombstoneTicket,
} from './store';

/** Bounded re-reads: each pass follows a decision another concurrent request may have changed. */
const ACQUIRE_PASSES = 4;

/**
 * The per-account coordinator. It holds the account's single valid ticket, which is what makes "one
 * queue seat per account, across difficulties" enforceable, and reconciles that ticket with the seat
 * reservation that lives in the room.
 */
export class AccountTickets {
  constructor(private readonly scope: MatchmakerScope) {}

  /**
   * Idempotent: repeated polls return the same ticket. A waiting ticket is refreshed and re-asserted
   * in the queue on every poll, which makes a lost queue entry self-healing instead of a permanently
   * stuck "waiting" state; a matched ticket follows the room instead of expiring underneath a match.
   *
   * Every pass re-reads the ticket, so concurrent calls for one account can only ever move the single
   * stored ticket forward — a pass never mints a request that another pass already replaced.
   */
  async acquire(user: User): Promise<MatchTicket> {
    const scope = this.scope;
    for (let pass = 0; pass < ACQUIRE_PASSES; pass += 1) {
      const now = Date.now();
      const existing = readTicket(scope, user.id);
      if (!existing) return this.waitInQueue(user, crypto.randomUUID());

      if (existing.state === 'cancelling') {
        // A cancellation has not been confirmed by the queue yet: finish it rather than hand out a
        // match, then re-read, because finishing it may have raced another request of this account.
        const outcome = await finishCancel(scope, existing);
        if (outcome.heldRoomId) return this.matchedOrRefuse(user.id);
        if (!outcome.cancelled) throw new MatchRejection('match:cancelled');
        continue;
      }

      if (existing.state === 'matched') {
        const verdict = await reconcileMatched(scope, user, existing);
        if (verdict.kind === 'ticket') return verdict.ticket;
        if (verdict.kind === 'stale') {
          // Another request already answered for this account: return that ticket rather than
          // minting a new one, and never resurrect a request the account cancelled.
          if (verdict.ticket) return verdict.ticket;
          throw new MatchRejection('match:cancelled');
        }
        // The seat is gone and this pass owned the ticket that was deleted. Start a new request only
        // if no other pass created one meanwhile; otherwise follow that one instead of overwriting it.
        if (readTicket(scope, user.id)) continue;
        return this.waitInQueue(user, crypto.randomUUID());
      }

      if (existing.expires_at > now) {
        return this.waitInQueue(user, existing.request_id);
      }

      // The lease lapsed, but the queue may still hold the entry — or a pairing it already prepared.
      // Release it through the durable cancellation path before starting a new request, so a lapsed
      // lease can never leave a queue entry, a pairing, or a live room behind.
      tombstoneTicket(scope, user.id, existing.request_id);
      const outcome = await finishCancel(scope, existing);
      if (outcome.heldRoomId) return this.matchedOrRefuse(user.id);
      if (!outcome.cancelled) throw new MatchRejection('match:cancelled');
    }

    const row = readTicket(scope, user.id);
    if (!row || row.state === 'cancelling') throw new MatchRejection('match:cancelled');
    return ticketFor(row);
  }

  /**
   * Cancels matchmaking for this account. `cancelled: true` means the account holds no ticket and no
   * live seat; `false` means a started match still holds the seat, or the queue could not confirm the
   * cancellation — in which case the durable `cancelling` tombstone stays in place and is retried.
   */
  async cancel(userId: string): Promise<MatchCancelResult> {
    const scope = this.scope;
    const row = readTicket(scope, userId);
    if (!row) return { cancelled: true };
    if (row.state === 'matched') {
      const roomId = row.room_id;
      if (!roomId) {
        deleteTicket(scope, userId, row.request_id);
        return { cancelled: true };
      }
      const reservation = await readReservation(scope.env, roomId);
      if (reservation === 'locked') {
        if (!(await matchIsLive(scope.env, userId, roomId))) {
          // The match no longer holds this account: it was settled, or this
          // account explicitly abandoned it — the seat is free either way.
          deleteTicket(scope, userId, row.request_id);
          return { cancelled: true };
        }
        return { cancelled: false };
      }
      if (reservation === 'reserved') {
        let terminated = false;
        try {
          terminated = await roomStub(scope.env, roomId).cancelReservation(userId);
        } catch (error) {
          console.error(
            'matchmaker: cancelReservation failed',
            error instanceof Error ? error.message : error,
          );
          return { cancelled: false };
        }
        if (!terminated) return { cancelled: false };
      }
      deleteTicket(scope, userId, row.request_id);
      return { cancelled: true };
    }
    if (row.state === 'waiting') {
      // Tombstone synchronously: no pairing can be published for this request from now on, and the
      // tombstone survives until the queue confirms, so the answer cannot overstate the result.
      tombstoneTicket(scope, userId, row.request_id);
    }
    const outcome = await finishCancel(scope, row);
    return { cancelled: outcome.cancelled };
  }

  /**
   * Retries what the coordinator still owes: cancellations that never reached the queue, and waiting
   * leases that lapsed. A lapsed lease is expired through the same durable path — never a bare delete
   * — because the queue may already have paired it into a live room. Matched tickets are never expired
   * here: their fate follows the room, not the clock.
   */
  async alarm(): Promise<void> {
    const scope = this.scope;
    const now = Date.now();
    for (const row of scope.sql
      .exec<TicketRow>("SELECT * FROM ticket WHERE state = 'cancelling'")
      .toArray()) {
      await finishCancel(scope, row);
    }
    for (const row of scope.sql
      .exec<TicketRow>("SELECT * FROM ticket WHERE state = 'waiting' AND expires_at <= ?", now)
      .toArray()) {
      tombstoneTicket(scope, row.user_id, row.request_id);
      await finishCancel(scope, row);
    }
    const waiting = scope.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(expires_at) AS next FROM ticket WHERE state = 'waiting'",
      )
      .one().next;
    const cancelling = scope.sql
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM ticket WHERE state = 'cancelling'")
      .one().total;
    const next = Math.min(
      waiting ?? Number.POSITIVE_INFINITY,
      cancelling > 0 ? now + 60_000 : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(next)) await scope.storage.setAlarm(next);
  }

  private async waitInQueue(user: User, requestId: string): Promise<MatchTicket> {
    const scope = this.scope;
    const now = Date.now();
    const expiresAt = now + QUEUE_ENTRY_TTL_MS;
    // Written synchronously as the first statement of this call, immediately after the caller's read:
    // no await separates "this account has no ticket" from "this account waits with this request".
    startWaitingTicket(scope, {
      userId: user.id,
      username: user.username,
      requestId,
      expiresAt,
      now,
    });
    await armAlarm(scope, expiresAt);
    try {
      // A pairing may already exist from a pairing that happened while this account was away; it is
      // claimed without re-joining the queue, so a poll cannot race a second pairing into existence.
      const settled = await settle(scope, user.id, requestId);
      if (settled) return settled;
      if (isCurrentWaiting(scope, user.id, requestId)) {
        await queueStub(scope.env).join({
          userId: user.id,
          username: user.username,
          requestId,
          expiresAt,
        });
        const paired = await settle(scope, user.id, requestId);
        if (paired) return paired;
      }
    } catch (error) {
      console.error(
        'matchmaker: queue unavailable',
        error instanceof Error ? error.message : error,
      );
    }
    const current = readTicket(scope, user.id);
    if (!current || current.state === 'cancelling') throw new MatchRejection('match:cancelled');
    return ticketFor(current);
  }

  /** Answers with the matched ticket of a live match, or refuses when the ticket changed under us. */
  private matchedOrRefuse(userId: string): MatchTicket {
    const row = readTicket(this.scope, userId);
    if (row && row.state === 'matched' && row.room_id) return ticketFor(row);
    throw new MatchRejection('match:cancelled');
  }
}
