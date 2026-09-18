import { randomUUID } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { QUEUE_ENTRY_TTL_MS, RESERVATION_TTL_MS } from '../shared/protocol';
import type { Difficulty, MatchCancelResult, MatchTicket, ReservationState, RoomInit, User } from '../shared/protocol';
import type { Env } from './env';
import { errorText } from './http';
import { newRoomId, readDifficulty } from './ids';

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
 * waiting on it.
 */

const QUEUE_PREFIX = 'q:';
const USER_PREFIX = 'u:';

/** Bounded re-reads: each pass follows a decision another concurrent request may have changed. */
const ACQUIRE_PASSES = 4;

export function userShardName(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

export function queueShardName(difficulty: Difficulty): string {
  return `${QUEUE_PREFIX}${difficulty}`;
}

/** Preset themes for quick matches: neither player chooses the theme, and no client message can change it. */
const QUICK_THEMES: Record<Difficulty, string> = {
  easy: '魔法学院的新生比试',
  normal: '正统魔法师的咒文对决',
  hard: '禁咒试炼：高阶咒文对决'
};

type TicketState = 'waiting' | 'matched' | 'cancelling';

type TicketRow = {
  user_id: string;
  username: string;
  request_id: string;
  difficulty: Difficulty;
  state: TicketState;
  room_id: string | null;
  expires_at: number;
  updated_at: number;
};

/** The fields a cancellation needs; the ticket's state is irrelevant to the queue handshake. */
type CancelTarget = Pick<TicketRow, 'user_id' | 'request_id' | 'difficulty'>;

type WaitingRow = {
  user_id: string;
  username: string;
  request_id: string;
  difficulty: Difficulty;
  enqueued_at: number;
  expires_at: number;
};

type PairingRow = {
  room_id: string;
  user_a: string;
  request_a: string;
  user_b: string;
  request_b: string;
  state: 'preparing' | 'ready' | 'released';
  cleanup: number;
  difficulty: Difficulty;
  expires_at: number;
  created_at: number;
};

/** Outcome of reconciling a matched ticket: keep it, drop it, or hand over to whoever changed it. */
type MatchVerdict =
  | { kind: 'ticket'; ticket: MatchTicket }
  | { kind: 'dead' }
  | { kind: 'stale'; ticket: MatchTicket | null };

/**
 * Result of giving up an account's matchmaking. `heldRoomId` is set when a room still holds the
 * account's seat (a started match, or a reservation it refused to release): that seat cannot be
 * cancelled, so the account must stay matched to that room instead of being freed.
 */
interface CancelOutcome {
  cancelled: boolean;
  heldRoomId: string | null;
}

/** A ready pairing as seen by one of its two accounts. */
interface ClaimedPairing {
  room_id: string;
  request_id: string;
  expires_at: number;
}

interface QueueEntry {
  userId: string;
  username: string;
  requestId: string;
  difficulty: Difficulty;
  expiresAt: number;
}

export class Matchmaker extends DurableObject<Env> {
  private readonly queueShard: boolean;
  private readonly shardDifficulty: Difficulty | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name ?? '';
    this.queueShard = name.startsWith(QUEUE_PREFIX);
    this.shardDifficulty = this.queueShard ? readDifficulty(name.slice(QUEUE_PREFIX.length)) : null;
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS ticket (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, request_id TEXT NOT NULL, difficulty TEXT NOT NULL, state TEXT NOT NULL, room_id TEXT, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS waiting (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, request_id TEXT NOT NULL, difficulty TEXT NOT NULL, enqueued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)'
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS pairing (room_id TEXT PRIMARY KEY, user_a TEXT NOT NULL, request_a TEXT NOT NULL, user_b TEXT NOT NULL, request_b TEXT NOT NULL, state TEXT NOT NULL, cleanup INTEGER NOT NULL DEFAULT 0, difficulty TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
      );
      try {
        // Storage created before `cleanup` existed keeps working; the column is added once.
        sql.exec('ALTER TABLE pairing ADD COLUMN cleanup INTEGER NOT NULL DEFAULT 0');
      } catch {
        // Already present.
      }
    });
  }

  // ---------------------------------------------------------------- coordinator role

  /**
   * Idempotent: repeated polls return the same ticket. A waiting ticket is refreshed and re-asserted
   * in the queue on every poll, which makes a lost queue entry self-healing instead of a permanently
   * stuck "waiting" state; a matched ticket follows the room instead of expiring underneath a match.
   *
   * Every pass re-reads the ticket, so concurrent calls for one account can only ever move the single
   * stored ticket forward — a pass never mints a request that another pass already replaced.
   */
  async acquire(user: User, difficulty: Difficulty): Promise<MatchTicket> {
    if (this.queueShard) throw new Error('matchmaker: wrong shard role');
    for (let pass = 0; pass < ACQUIRE_PASSES; pass += 1) {
      const now = Date.now();
      const existing = this.readTicket(user.id);
      if (!existing) return this.waitInQueue(user, difficulty, randomUUID());

      if (existing.state === 'cancelling') {
        // A cancellation has not been confirmed by the queue yet: finish it rather than hand out a
        // match, then re-read, because finishing it may have raced another request of this account.
        const outcome = await this.finishCancel(existing);
        if (outcome.heldRoomId) return this.matchedOrRefuse(user.id);
        if (!outcome.cancelled) throw new Error('match:cancelled');
        continue;
      }

      if (existing.state === 'matched') {
        const verdict = await this.reconcileMatched(user, existing);
        if (verdict.kind === 'ticket') return verdict.ticket;
        if (verdict.kind === 'stale') {
          // Another request already answered for this account: return that ticket rather than
          // minting a new one, and never resurrect a request the account cancelled.
          if (verdict.ticket) return verdict.ticket;
          throw new Error('match:cancelled');
        }
        // The seat is gone and this pass owned the ticket that was deleted. Start a new request only
        // if no other pass created one meanwhile; otherwise follow that one instead of overwriting it.
        if (this.readTicket(user.id)) continue;
        return this.waitInQueue(user, difficulty, randomUUID());
      }

      if (existing.expires_at > now) {
        if (existing.difficulty !== difficulty) throw new Error('match:conflict');
        return this.waitInQueue(user, difficulty, existing.request_id);
      }

      // The lease lapsed, but the queue may still hold the entry — or a pairing it already prepared.
      // Release it through the durable cancellation path before starting a new request, so a lapsed
      // lease can never leave a queue entry, a pairing, or a live room behind.
      this.sql.exec(
        "UPDATE ticket SET state = 'cancelling', updated_at = ? WHERE user_id = ? AND request_id = ?",
        now,
        user.id,
        existing.request_id
      );
      const outcome = await this.finishCancel(existing);
      if (outcome.heldRoomId) return this.matchedOrRefuse(user.id);
      if (!outcome.cancelled) throw new Error('match:cancelled');
    }

    const row = this.readTicket(user.id);
    if (!row || row.state === 'cancelling') throw new Error('match:cancelled');
    return this.ticketFor(row);
  }

  /**
   * Cancels matchmaking for this account. `cancelled: true` means the account holds no ticket and no
   * live seat; `false` means a started match still holds the seat, or the queue could not confirm the
   * cancellation — in which case the durable `cancelling` tombstone stays in place and is retried.
   */
  async cancel(userId: string): Promise<MatchCancelResult> {
    if (this.queueShard) throw new Error('matchmaker: wrong shard role');
    const row = this.readTicket(userId);
    if (!row) return { cancelled: true };
    if (row.state === 'matched') {
      const roomId = row.room_id;
      if (!roomId) {
        this.deleteTicket(userId, row.request_id);
        return { cancelled: true };
      }
      const reservation = await this.readReservation(roomId);
      if (reservation === 'locked') return { cancelled: false };
      if (reservation === 'reserved') {
        let terminated = false;
        try {
          terminated = await this.roomStub(roomId).cancelReservation(userId);
        } catch (err) {
          console.error('matchmaker: cancelReservation failed', errorText(err));
          return { cancelled: false };
        }
        if (!terminated) return { cancelled: false };
      }
      this.deleteTicket(userId, row.request_id);
      return { cancelled: true };
    }
    if (row.state === 'waiting') {
      // Tombstone synchronously: no pairing can be published for this request from now on, and the
      // tombstone survives until the queue confirms, so the answer cannot overstate the result.
      this.sql.exec(
        "UPDATE ticket SET state = 'cancelling', updated_at = ? WHERE user_id = ? AND request_id = ?",
        Date.now(),
        userId,
        row.request_id
      );
    }
    const outcome = await this.finishCancel(row);
    return { cancelled: outcome.cancelled };
  }

  /** Decides the fate of the account's matched ticket after the room has been consulted. */
  private async reconcileMatched(user: User, row: TicketRow): Promise<MatchVerdict> {
    const roomId = row.room_id;
    if (!roomId) {
      this.deleteTicket(user.id, row.request_id);
      return { kind: 'dead' };
    }
    const reservation = await this.readReservation(roomId);
    const current = this.readTicket(user.id);
    if (!current || current.request_id !== row.request_id || current.state !== 'matched') {
      // The ticket changed while the reservation was being read: the changed ticket owns the answer.
      return { kind: 'stale', ticket: current ? this.ticketFor(current) : null };
    }
    if (reservation === 'locked' && !(await this.matchIsLive(user, roomId))) {
      // The running match is over, so the seat no longer blocks a new one.
      this.deleteTicket(user.id, row.request_id);
      return { kind: 'dead' };
    }
    if (reservation !== 'reserved' && reservation !== 'locked') {
      // Reservation cancelled, expired, or the room is gone: drop the stale ticket.
      this.deleteTicket(user.id, row.request_id);
      return { kind: 'dead' };
    }
    const expiresAt = Math.max(current.expires_at, Date.now() + RESERVATION_TTL_MS);
    this.sql.exec(
      'UPDATE ticket SET expires_at = ?, updated_at = ? WHERE user_id = ? AND request_id = ?',
      expiresAt,
      Date.now(),
      user.id,
      row.request_id
    );
    return { kind: 'ticket', ticket: { state: 'matched', difficulty: row.difficulty, roomId, expiresAt } };
  }

  /**
   * A locked room seat whose match has not finished still belongs to this account, so it keeps its
   * ticket instead of being given a second queue seat mid-game. An unreachable room keeps the seat
   * too: the safe direction is refusing a new match, never handing out a duplicate one.
   */
  private async matchIsLive(user: User, roomId: string): Promise<boolean> {
    try {
      const snapshot = await this.roomStub(roomId).snapshot(user);
      return snapshot.phase !== 'finished';
    } catch (err) {
      const message = errorText(err);
      if (message.includes('room:not_found') || message.includes('room:reservation_gone')) return false;
      console.warn('matchmaker: match state unavailable, keeping the seat', message);
      return true;
    }
  }

  private async waitInQueue(user: User, difficulty: Difficulty, requestId: string): Promise<MatchTicket> {
    const now = Date.now();
    const expiresAt = now + QUEUE_ENTRY_TTL_MS;
    // Written synchronously as the first statement of this call, immediately after the caller's read:
    // no await separates "this account has no ticket" from "this account waits with this request".
    this.sql.exec(
      "INSERT INTO ticket (user_id, username, request_id, difficulty, state, room_id, expires_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', NULL, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, request_id = excluded.request_id, difficulty = excluded.difficulty, state = 'waiting', room_id = NULL, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
      user.id,
      user.username,
      requestId,
      difficulty,
      expiresAt,
      now
    );
    await this.armAlarm(expiresAt);
    try {
      // A pairing may already exist from a pairing that happened while this account was away; it is
      // claimed without re-joining the queue, so a poll cannot race a second pairing into existence.
      const settled = await this.settle(user.id, difficulty, requestId);
      if (settled) return settled;
      if (this.isCurrentWaiting(user.id, requestId)) {
        await this.queueStub(difficulty).join({
          userId: user.id,
          username: user.username,
          requestId,
          difficulty,
          expiresAt
        });
        const paired = await this.settle(user.id, difficulty, requestId);
        if (paired) return paired;
      }
    } catch (err) {
      console.error('matchmaker: queue unavailable', errorText(err));
    }
    const current = this.readTicket(user.id);
    if (!current || current.state === 'cancelling') throw new Error('match:cancelled');
    return this.ticketFor(current);
  }

  /**
   * Reads the ready pairings for this account. The pairing row is never consumed here: it is already
   * durable in the queue, so a shard that restarts between claiming and answering simply reads it
   * again. A pairing that no longer belongs to the current request is released, which frees the room
   * for the other account instead of leaving a match that nobody was told about.
   */
  private async settle(userId: string, difficulty: Difficulty, requestId: string): Promise<MatchTicket | null> {
    const queue = this.queueStub(difficulty);
    const claimed = await queue.claim(userId);
    if (claimed.length === 0) return null;
    const mine = claimed.find((entry) => entry.request_id === requestId) ?? null;
    let heldRoomId: string | null = null;
    for (const entry of claimed) {
      if (entry === mine) continue;
      heldRoomId = (await queue.release(entry.room_id, userId, entry.request_id)) ?? heldRoomId;
    }
    if (heldRoomId && this.isCurrentRequest(userId, requestId)) {
      // An earlier pairing of this account still holds a room: keep that seat, add no entry.
      this.recordHeldSeat({ user_id: userId, request_id: requestId, difficulty }, heldRoomId);
      return { state: 'matched', difficulty, roomId: heldRoomId, expiresAt: Date.now() + RESERVATION_TTL_MS };
    }
    if (!mine) return null;
    const current = this.readTicket(userId);
    if (
      current &&
      current.request_id === requestId &&
      current.state === 'matched' &&
      current.room_id === mine.room_id
    ) {
      // Another poll already recorded this pairing: answer it, never release a live room.
      return { state: 'matched', difficulty: current.difficulty, roomId: mine.room_id, expiresAt: current.expires_at };
    }
    if (!current || current.request_id !== requestId || current.state !== 'waiting') {
      const heldId = await queue.release(mine.room_id, userId, mine.request_id);
      if (heldId && this.isCurrentRequest(userId, requestId)) {
        this.recordHeldSeat({ user_id: userId, request_id: requestId, difficulty }, heldId);
        return { state: 'matched', difficulty, roomId: heldId, expiresAt: Date.now() + RESERVATION_TTL_MS };
      }
      return null;
    }
    this.sql.exec(
      "UPDATE ticket SET state = 'matched', room_id = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND request_id = ?",
      mine.room_id,
      mine.expires_at,
      Date.now(),
      userId,
      requestId
    );
    await queue.leave(userId, requestId);
    return { state: 'matched', difficulty: current.difficulty, roomId: mine.room_id, expiresAt: mine.expires_at };
  }

  /** Answers with the account's current ticket as it stands; never invents a new request. */
  private ticketFor(row: TicketRow): MatchTicket {
    if (row.state === 'matched' && row.room_id) {
      return { state: 'matched', difficulty: row.difficulty, roomId: row.room_id, expiresAt: row.expires_at };
    }
    return { state: 'waiting', difficulty: row.difficulty, expiresAt: row.expires_at };
  }

  private isCurrentWaiting(userId: string, requestId: string): boolean {
    const row = this.readTicket(userId);
    return row !== null && row.state === 'waiting' && row.request_id === requestId;
  }

  /** True while this request is still the account's ticket, in either direction of the flow. */
  private isCurrentRequest(userId: string, requestId: string): boolean {
    const row = this.readTicket(userId);
    return row !== null && row.request_id === requestId && row.state !== 'cancelling';
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
  private async finishCancel(row: CancelTarget): Promise<CancelOutcome> {
    let retained: string[];
    try {
      retained = await this.queueStub(row.difficulty).abort(row.user_id, row.request_id);
    } catch (err) {
      console.error('matchmaker: cancel cleanup failed', errorText(err));
      return { cancelled: false, heldRoomId: null };
    }
    const heldRoomId = retained[0] ?? null;
    if (heldRoomId) {
      this.recordHeldSeat(row, heldRoomId);
      return { cancelled: false, heldRoomId };
    }
    this.deleteTicket(row.user_id, row.request_id);
    return { cancelled: true, heldRoomId: null };
  }

  /** Keeps the account matched to a room that still holds its seat; the seat is not cancellable. */
  private recordHeldSeat(row: CancelTarget, roomId: string): void {
    const now = Date.now();
    this.sql.exec(
      "UPDATE ticket SET state = 'matched', room_id = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND request_id = ?",
      roomId,
      now + RESERVATION_TTL_MS,
      now,
      row.user_id,
      row.request_id
    );
  }

  /** Answers with the matched ticket of a live match, or refuses when the ticket changed under us. */
  private matchedOrRefuse(userId: string): MatchTicket {
    const row = this.readTicket(userId);
    if (row && row.state === 'matched' && row.room_id) return this.ticketFor(row);
    throw new Error('match:cancelled');
  }

  // ---------------------------------------------------------------- queue role

  /**
   * Registers (or refreshes) an entry and attempts exactly one pairing with the oldest other entry.
   * An account that is already being matched keeps its single in-flight pairing.
   */
  async join(entry: QueueEntry): Promise<void> {
    if (!this.queueShard) throw new Error('matchmaker: wrong shard role');
    const now = Date.now();
    if (this.hasLivePairing(entry.userId, now)) return;
    this.sql.exec('DELETE FROM waiting WHERE expires_at <= ?', now);
    this.sql.exec(
      'INSERT INTO waiting (user_id, username, request_id, difficulty, enqueued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, request_id = excluded.request_id, difficulty = excluded.difficulty, expires_at = excluded.expires_at',
      entry.userId,
      entry.username,
      entry.requestId,
      entry.difficulty,
      now,
      entry.expiresAt
    );
    const partner = this.sql
      .exec<WaitingRow>(
        'SELECT * FROM waiting WHERE user_id != ? AND expires_at > ? ORDER BY enqueued_at ASC, user_id ASC LIMIT 1',
        entry.userId,
        now
      )
      .toArray()[0];
    if (!partner) {
      const next = this.nextQueueExpiry();
      if (next !== null) await this.armAlarm(next);
      return;
    }
    // Both entries and the pairing record are written synchronously, before any await: no concurrent
    // join can reuse either entry, and a cancellation can already find the pairing.
    this.sql.exec('DELETE FROM waiting WHERE user_id IN (?, ?)', entry.userId, partner.user_id);
    const roomId = newRoomId();
    const expiresAt = now + RESERVATION_TTL_MS;
    this.sql.exec(
      "INSERT INTO pairing (room_id, user_a, request_a, user_b, request_b, state, cleanup, difficulty, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?)",
      roomId,
      entry.userId,
      entry.requestId,
      partner.user_id,
      partner.request_id,
      entry.difficulty,
      expiresAt,
      now
    );
    // `host` is implicit in the room's roster, so only the partner is passed as a reserved seat.
    const room: RoomInit = {
      id: roomId,
      host: { id: entry.userId, username: entry.username },
      theme: QUICK_THEMES[entry.difficulty],
      difficulty: entry.difficulty,
      mode: 'quick',
      reserved: [{ id: partner.user_id, username: partner.username }]
    };
    try {
      await this.roomStub(roomId).initialize(room);
    } catch (err) {
      console.error('matchmaker: quick room reservation failed', errorText(err));
      // Neither entry is restored: a waiting account re-enters the queue on its own next poll, and an
      // account that cancelled meanwhile must stay cancelled.
      this.sql.exec('DELETE FROM pairing WHERE room_id = ?', roomId);
      return;
    }
    const pairing = this.sql.exec<PairingRow>('SELECT * FROM pairing WHERE room_id = ?', roomId).toArray()[0];
    if (!pairing || pairing.state === 'released') {
      // Cancelled (or tombstoned) while the room was being prepared: the seat is released instead of
      // being published to an account that asked to leave. A failure stays pending for the alarm.
      this.sql.exec("UPDATE pairing SET cleanup = 1 WHERE room_id = ? AND state = 'released'", roomId);
      const outcome = await this.releaseRoom(roomId, entry.userId);
      if (outcome === 'retained') {
        // The room still holds these seats and will not release them: keep the pairing claimable
        // instead of pretending either account was released.
        console.warn('matchmaker: prepared pairing still holds room seats', roomId);
      } else if (outcome === 'failed') {
        console.error('matchmaker: released pairing still holds a reservation', roomId);
      }
      return;
    }
    const ready = Date.now() + RESERVATION_TTL_MS;
    this.sql.exec("UPDATE pairing SET state = 'ready', expires_at = ? WHERE room_id = ? AND state = 'preparing'", ready, roomId);
    await this.armAlarm(ready);
  }

  /** Ready pairings for one account. Reading does not consume them, so a retry can always re-read. */
  async claim(userId: string): Promise<ClaimedPairing[]> {
    if (!this.queueShard) throw new Error('matchmaker: wrong shard role');
    return this.sql
      .exec<PairingRow>(
        'SELECT * FROM pairing WHERE (user_a = ? OR user_b = ?) AND state = ? AND expires_at > ?',
        userId,
        userId,
        'ready',
        Date.now()
      )
      .toArray()
      .map((row) => ({
        room_id: row.room_id,
        request_id: row.user_a === userId ? row.request_a : row.request_b,
        expires_at: row.expires_at
      }));
  }

  /** Drops a queue entry without touching any reservation. */
  async leave(userId: string, requestId: string): Promise<void> {
    if (!this.queueShard) throw new Error('matchmaker: wrong shard role');
    this.sql.exec('DELETE FROM waiting WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  /**
   * Cancels an account's matchmaking: the queue entry goes away and every unfinished pairing is
   * tombstoned with `cleanup = 1`, then each reserved room is released. Rooms that still hold a seat
   * are returned so the caller can keep the account matched to them; a room that cannot be reached
   * keeps its pending cleanup and makes this call throw, because the caller must not report success
   * while a seat may still exist.
   */
  async abort(userId: string, requestId: string): Promise<string[]> {
    if (!this.queueShard) throw new Error('matchmaker: wrong shard role');
    const now = Date.now();
    this.sql.exec('DELETE FROM waiting WHERE user_id = ? AND request_id = ?', userId, requestId);
    this.sql.exec(
      "UPDATE pairing SET state = 'released', cleanup = 1 WHERE (user_a = ? OR user_b = ?) AND state != 'released' AND expires_at > ?",
      userId,
      userId,
      now
    );
    const pending = this.sql
      .exec<PairingRow>(
        'SELECT * FROM pairing WHERE (user_a = ? OR user_b = ?) AND cleanup = 1 AND expires_at > ?',
        userId,
        userId,
        now
      )
      .toArray();
    const retained: string[] = [];
    let failed = false;
    for (const row of pending) {
      const outcome = await this.releaseRoom(row.room_id, row.user_a);
      if (outcome === 'retained') retained.push(row.room_id);
      if (outcome === 'failed') failed = true;
    }
    if (failed) throw new Error('match:cleanup');
    return retained;
  }

  /**
   * Gives up one prepared pairing, so the other account can be matched again instead of waiting.
   * Returns the room id when that room still holds the seats and refused to release them, so the
   * caller must keep the account matched to it rather than queueing it again.
   */
  async release(roomId: string, userId: string, requestId: string): Promise<string | null> {
    if (!this.queueShard) throw new Error('matchmaker: wrong shard role');
    this.sql.exec('DELETE FROM waiting WHERE user_id = ? AND request_id = ?', userId, requestId);
    this.sql.exec("UPDATE pairing SET state = 'released', cleanup = 1 WHERE room_id = ? AND state != 'released'", roomId);
    const row = this.sql.exec<PairingRow>('SELECT * FROM pairing WHERE room_id = ?', roomId).toArray()[0];
    if (row && row.state === 'released' && row.cleanup === 0) return null;
    const outcome = await this.releaseRoom(roomId, userId);
    if (outcome === 'failed') throw new Error('match:cleanup');
    if (outcome === 'retained' && row) return roomId;
    return null;
  }

  /**
   * Releases a room reservation.
   *
   * - `'released'`: this account holds no seat any more — either the room confirmed the release, or
   *   the room does not exist, or its reservation is `none`/`cancelled`/`expired`. `cleanup` is
   *   cleared only here.
   * - `'retained'`: the room still holds a seat for this account (a started match, or a reservation it
   *   will not release for anyone but a participant). The pairing stays claimable (`ready`) so neither
   *   account can be handed a second seat, and the caller must not report success.
   * - `'failed'`: the room could not be reached, so nothing may be concluded. `cleanup` stays set and
   *   the alarm retries.
   *
   * A `false` answer alone cannot decide this: the room also answers `false` for an id it never
   * initialized and for an account it no longer knows, so the reservation state is authoritative and
   * its absence is treated as "still held" only when the room actually says so.
   */
  private async releaseRoom(roomId: string, userId: string): Promise<'released' | 'retained' | 'failed'> {
    let released: boolean;
    try {
      released = await this.roomStub(roomId).cancelReservation(userId);
    } catch (err) {
      const message = errorText(err);
      if (message.includes('room:not_found')) {
        this.clearCleanup(roomId);
        return 'released';
      }
      console.error('matchmaker: reservation cleanup failed', message);
      return 'failed';
    }
    if (released) {
      this.clearCleanup(roomId);
      return 'released';
    }
    const reservation = await this.probeReservation(roomId);
    if (reservation === 'none' || reservation === 'cancelled' || reservation === 'expired') {
      this.clearCleanup(roomId);
      return 'released';
    }
    if (reservation === 'unreachable') {
      console.error('matchmaker: reservation state unknown after a refused release', roomId);
      return 'failed';
    }
    this.sql.exec("UPDATE pairing SET state = 'ready', cleanup = 0 WHERE room_id = ? AND state = 'released'", roomId);
    return 'retained';
  }

  /** Reservation state for cleanup decisions; an unreachable room is reported as such, never guessed. */
  private async probeReservation(roomId: string): Promise<ReservationState | 'unreachable'> {
    try {
      return await this.roomStub(roomId).reservationState();
    } catch (err) {
      const message = errorText(err);
      if (message.includes('room:not_found')) return 'none';
      console.warn('matchmaker: reservation state unavailable', message);
      return 'unreachable';
    }
  }

  private clearCleanup(roomId: string): void {
    this.sql.exec('UPDATE pairing SET cleanup = 0 WHERE room_id = ?', roomId);
  }

  // ---------------------------------------------------------------- shared

  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.queueShard) {
      // Pending room releases are retried first: a pairing is only clean once the room answered.
      for (const row of this.sql
        .exec<PairingRow>('SELECT * FROM pairing WHERE cleanup = 1 AND expires_at > ?', now)
        .toArray()) {
        await this.releaseRoom(row.room_id, row.user_a);
      }
      this.sql.exec('DELETE FROM waiting WHERE expires_at <= ?', now);
      this.sql.exec('DELETE FROM pairing WHERE expires_at <= ?', now);
      const next = this.nextQueueExpiry();
      if (next !== null) await this.ctx.storage.setAlarm(next);
      return;
    }
    // Cancellations that could not reach the queue are retried here until they confirm.
    for (const row of this.sql.exec<TicketRow>("SELECT * FROM ticket WHERE state = 'cancelling'").toArray()) {
      await this.finishCancel(row);
    }
    // A lapsed waiting lease is expired through the same durable path — never a bare delete — because
    // the queue may already have paired it into a live room.
    for (const row of this.sql
      .exec<TicketRow>("SELECT * FROM ticket WHERE state = 'waiting' AND expires_at <= ?", now)
      .toArray()) {
      this.sql.exec(
        "UPDATE ticket SET state = 'cancelling', updated_at = ? WHERE user_id = ? AND request_id = ?",
        now,
        row.user_id,
        row.request_id
      );
      await this.finishCancel(row);
    }
    // Matched tickets are never expired here: their fate follows the room, not the clock.
    const waiting = this.sql
      .exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM ticket WHERE state = 'waiting'")
      .one().next;
    const cancelling = this.sql
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM ticket WHERE state = 'cancelling'")
      .one().total;
    const next = Math.min(
      waiting ?? Number.POSITIVE_INFINITY,
      cancelling > 0 ? now + 60_000 : Number.POSITIVE_INFINITY
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private readTicket(userId: string): TicketRow | null {
    return this.sql.exec<TicketRow>('SELECT * FROM ticket WHERE user_id = ?', userId).toArray()[0] ?? null;
  }

  private deleteTicket(userId: string, requestId: string): void {
    this.sql.exec('DELETE FROM ticket WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  private hasLivePairing(userId: string, now: number): boolean {
    return (
      this.sql
        .exec<{ room_id: string }>(
          'SELECT room_id FROM pairing WHERE (user_a = ? OR user_b = ?) AND state != ? AND expires_at > ? LIMIT 1',
          userId,
          userId,
          'released',
          now
        )
        .toArray().length > 0
    );
  }

  private queueStub(difficulty: Difficulty) {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName(queueShardName(difficulty)));
  }

  private roomStub(roomId: string) {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
  }

  private async readReservation(roomId: string): Promise<ReservationState> {
    try {
      return await this.roomStub(roomId).reservationState();
    } catch (err) {
      // Unknown reservation state: keep the ticket rather than dropping a seat that may still be live.
      console.error('matchmaker: reservationState failed', errorText(err));
      return 'reserved';
    }
  }

  private nextQueueExpiry(): number | null {
    const row = this.sql
      .exec<{ next: number | null }>(
        'SELECT MIN(expires) AS next FROM (SELECT expires_at AS expires FROM waiting UNION ALL SELECT expires_at AS expires FROM pairing)'
      )
      .one();
    return row.next;
  }

  private async armAlarm(expiry: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > expiry) await this.ctx.storage.setAlarm(expiry);
  }
}
