import { DurableObject } from 'cloudflare:workers';
import type { Difficulty, MatchCancelResult, MatchTicket, User } from '../../shared/protocol';
import type { Env } from '../env';
import { QUEUE_SHARD_PREFIX } from '../ids';
import { AccountTickets } from './account';
import { QueueShard } from './queue';
import { createSchema } from './schema';
import type { ClaimedPairing, QueueEntry } from './schema';
import type { MatchmakerScope } from './scope';

/**
 * One Durable Object class, two shard roles selected by the object name:
 *
 * - `u:<userId>` — per-account coordinator. Holds the account's single valid ticket, which is what
 *   makes "one queue seat per account, across difficulties" enforceable, and reconciles that ticket
 *   with the seat reservation that lives in the room.
 * - `q:<difficulty>` — per-difficulty queue. Pairs two distinct accounts and reserves their seats in
 *   one quick room. It is the only place that decides a pairing, so two shards can never claim the
 *   same account, and it never calls back into an account that is waiting on it.
 *
 * Nothing here is decided from memory. Three durable records carry the invariants:
 *
 * 1. The queue writes a `pairing` row (`preparing`) *before* it awaits the room, so a cancellation
 *    that arrives while the room is still initializing finds it and marks it `released`. The
 *    in-flight pairing re-reads that row afterwards and cancels the room instead of publishing a
 *    match nobody asked for.
 * 2. A cancelled or lapsed ticket becomes `cancelling` synchronously and is only deleted once the
 *    queue has confirmed; a pairing whose room cancellation fails keeps `cleanup = 1` and is retried
 *    by the queue's own alarm until the room answers, so a "released" row never hides a live room.
 * 3. Every continuation re-reads the ticket and answers with what it finds. Only the request that
 *    currently owns the account may create or replace a ticket; a stale continuation returns the
 *    current ticket or refuses with `match:cancelled`.
 *
 * Calls flow one way only — coordinator → queue → room — so no shard ever waits on a shard that is
 * waiting on it. This class is the platform adapter: it selects the role and exposes both roles' RPC
 * methods, while every decision lives in the role modules beside it.
 */
export class Matchmaker extends DurableObject<Env> {
  private readonly account: AccountTickets | null;
  private readonly queue: QueueShard | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const scope: MatchmakerScope = { env, storage: ctx.storage, sql: ctx.storage.sql };
    const isQueueShard = (ctx.id.name ?? '').startsWith(QUEUE_SHARD_PREFIX);
    this.account = isQueueShard ? null : new AccountTickets(scope);
    this.queue = isQueueShard ? new QueueShard(scope) : null;
    void ctx.blockConcurrencyWhile(async () => {
      createSchema(ctx.storage.sql);
    });
  }

  // ---------------------------------------------------------------- coordinator role

  /** One poll of the account's ticket: join, answer, or reconcile a matched seat. */
  async acquire(user: User, difficulty: Difficulty): Promise<MatchTicket> {
    return this.coordinator().acquire(user, difficulty);
  }

  async cancel(userId: string): Promise<MatchCancelResult> {
    return this.coordinator().cancel(userId);
  }

  // ---------------------------------------------------------------------- queue role

  async join(entry: QueueEntry): Promise<void> {
    return this.queueShard().join(entry);
  }

  async claim(userId: string): Promise<ClaimedPairing[]> {
    return this.queueShard().claim(userId);
  }

  async leave(userId: string, requestId: string): Promise<void> {
    return this.queueShard().leave(userId, requestId);
  }

  async abort(userId: string, requestId: string): Promise<string[]> {
    return this.queueShard().abort(userId, requestId);
  }

  async release(roomId: string, userId: string, requestId: string): Promise<string | null> {
    return this.queueShard().release(roomId, userId, requestId);
  }

  // ---------------------------------------------------------------- shared

  async alarm(): Promise<void> {
    if (this.queue) return this.queue.alarm();
    return this.coordinator().alarm();
  }

  private coordinator(): AccountTickets {
    if (!this.account) throw new Error('matchmaker: wrong shard role');
    return this.account;
  }

  private queueShard(): QueueShard {
    if (!this.queue) throw new Error('matchmaker: wrong shard role');
    return this.queue;
  }
}
