import { RESERVATION_TTL_MS } from '../../shared/protocol';
import type { Difficulty, RoomInit } from '../../shared/protocol';
import { newRoomId } from '../ids';
import type { ClaimedPairing, PairingRow, QueueEntry, WaitingRow } from './schema';
import { probeReservation, roomStub } from './rooms';
import { armAlarm } from './scope';
import type { MatchmakerScope } from './scope';

/** Preset themes for quick matches: neither player chooses the theme, and no client message can change it. */
const QUICK_THEMES: Record<Difficulty, string> = {
  easy: '魔法学院的新生比试',
  normal: '正统魔法师的咒文对决',
  hard: '禁咒试炼：高阶咒文对决',
};

/** One prepared pairing's own state, as the queue needs it while it finishes or gives up the room. */
type RoomOutcome = 'released' | 'retained' | 'failed';

/**
 * The per-difficulty queue. It pairs two distinct accounts and reserves their seats in one quick room,
 * and it is the only place that decides a pairing, so two shards can never claim the same account.
 */
export class QueueShard {
  constructor(private readonly scope: MatchmakerScope) {}

  /**
   * Registers (or refreshes) an entry and attempts exactly one pairing with the oldest other entry.
   * An account that is already being matched keeps its single in-flight pairing.
   */
  async join(entry: QueueEntry): Promise<void> {
    const scope = this.scope;
    const sql = scope.sql;
    const now = Date.now();
    if (this.hasLivePairing(entry.userId, now)) return;
    sql.exec('DELETE FROM waiting WHERE expires_at <= ?', now);
    sql.exec(
      'INSERT INTO waiting (user_id, username, request_id, difficulty, enqueued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, request_id = excluded.request_id, difficulty = excluded.difficulty, expires_at = excluded.expires_at',
      entry.userId,
      entry.username,
      entry.requestId,
      entry.difficulty,
      now,
      entry.expiresAt,
    );
    const partner = sql
      .exec<WaitingRow>(
        'SELECT * FROM waiting WHERE user_id != ? AND expires_at > ? ORDER BY enqueued_at ASC, user_id ASC LIMIT 1',
        entry.userId,
        now,
      )
      .toArray()[0];
    if (!partner) {
      const next = this.nextQueueExpiry();
      if (next !== null) await armAlarm(scope, next);
      return;
    }
    // Both entries and the pairing record are written synchronously, before any await: no concurrent
    // join can reuse either entry, and a cancellation can already find the pairing.
    sql.exec('DELETE FROM waiting WHERE user_id IN (?, ?)', entry.userId, partner.user_id);
    const roomId = newRoomId();
    const expiresAt = now + RESERVATION_TTL_MS;
    sql.exec(
      "INSERT INTO pairing (room_id, user_a, request_a, user_b, request_b, state, cleanup, difficulty, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?)",
      roomId,
      entry.userId,
      entry.requestId,
      partner.user_id,
      partner.request_id,
      entry.difficulty,
      expiresAt,
      now,
    );
    // `host` is implicit in the room's roster, so only the partner is passed as a reserved seat.
    const room: RoomInit = {
      id: roomId,
      host: { id: entry.userId, username: entry.username },
      theme: QUICK_THEMES[entry.difficulty],
      difficulty: entry.difficulty,
      mode: 'quick',
      reserved: [{ id: partner.user_id, username: partner.username }],
    };
    try {
      await roomStub(scope.env, roomId).initialize(room);
    } catch (error) {
      console.error(
        'matchmaker: quick room reservation failed',
        error instanceof Error ? error.message : error,
      );
      // Neither entry is restored: a waiting account re-enters the queue on its own next poll, and an
      // account that cancelled meanwhile must stay cancelled.
      sql.exec('DELETE FROM pairing WHERE room_id = ?', roomId);
      return;
    }
    const pairing = sql
      .exec<PairingRow>('SELECT * FROM pairing WHERE room_id = ?', roomId)
      .toArray()[0];
    if (!pairing || pairing.state === 'released') {
      // Cancelled (or tombstoned) while the room was being prepared: the seat is released instead of
      // being published to an account that asked to leave. A failure stays pending for the alarm.
      sql.exec("UPDATE pairing SET cleanup = 1 WHERE room_id = ? AND state = 'released'", roomId);
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
    sql.exec(
      "UPDATE pairing SET state = 'ready', expires_at = ? WHERE room_id = ? AND state = 'preparing'",
      ready,
      roomId,
    );
    await armAlarm(scope, ready);
  }

  /** Ready pairings for one account. Reading does not consume them, so a retry can always re-read. */
  async claim(userId: string): Promise<ClaimedPairing[]> {
    return this.scope.sql
      .exec<PairingRow>(
        'SELECT * FROM pairing WHERE (user_a = ? OR user_b = ?) AND state = ? AND expires_at > ?',
        userId,
        userId,
        'ready',
        Date.now(),
      )
      .toArray()
      .map((row) => ({
        room_id: row.room_id,
        request_id: row.user_a === userId ? row.request_a : row.request_b,
        expires_at: row.expires_at,
      }));
  }

  /** Drops a queue entry without touching any reservation. */
  async leave(userId: string, requestId: string): Promise<void> {
    this.scope.sql.exec(
      'DELETE FROM waiting WHERE user_id = ? AND request_id = ?',
      userId,
      requestId,
    );
  }

  /**
   * Cancels an account's matchmaking: the queue entry goes away and every unfinished pairing is
   * tombstoned with `cleanup = 1`, then each reserved room is released. Rooms that still hold a seat
   * are returned so the caller can keep the account matched to them; a room that cannot be reached
   * keeps its pending cleanup and makes this call throw, because the caller must not report success
   * while a seat may still exist.
   */
  async abort(userId: string, requestId: string): Promise<string[]> {
    const scope = this.scope;
    const now = Date.now();
    scope.sql.exec('DELETE FROM waiting WHERE user_id = ? AND request_id = ?', userId, requestId);
    scope.sql.exec(
      "UPDATE pairing SET state = 'released', cleanup = 1 WHERE (user_a = ? OR user_b = ?) AND state != 'released' AND expires_at > ?",
      userId,
      userId,
      now,
    );
    const pending = scope.sql
      .exec<PairingRow>(
        'SELECT * FROM pairing WHERE (user_a = ? OR user_b = ?) AND cleanup = 1 AND expires_at > ?',
        userId,
        userId,
        now,
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
    const sql = this.scope.sql;
    sql.exec('DELETE FROM waiting WHERE user_id = ? AND request_id = ?', userId, requestId);
    sql.exec(
      "UPDATE pairing SET state = 'released', cleanup = 1 WHERE room_id = ? AND state != 'released'",
      roomId,
    );
    const row = sql
      .exec<PairingRow>('SELECT * FROM pairing WHERE room_id = ?', roomId)
      .toArray()[0];
    if (row && row.state === 'released' && row.cleanup === 0) return null;
    const outcome = await this.releaseRoom(roomId, userId);
    if (outcome === 'failed') throw new Error('match:cleanup');
    if (outcome === 'retained' && row) return roomId;
    return null;
  }

  /** Retries every pending room release first: a pairing is only clean once the room answered. */
  async alarm(): Promise<void> {
    const scope = this.scope;
    const now = Date.now();
    for (const row of scope.sql
      .exec<PairingRow>('SELECT * FROM pairing WHERE cleanup = 1 AND expires_at > ?', now)
      .toArray()) {
      await this.releaseRoom(row.room_id, row.user_a);
    }
    scope.sql.exec('DELETE FROM waiting WHERE expires_at <= ?', now);
    scope.sql.exec('DELETE FROM pairing WHERE expires_at <= ?', now);
    const next = this.nextQueueExpiry();
    if (next !== null) await scope.storage.setAlarm(next);
  }

  /**
   * Releases a room reservation.
   *
   * - `'released'`: this account holds no seat any more — either the room confirmed the release, or
   *   its reservation is `none`/`cancelled`/`expired`. `cleanup` is cleared only here.
   * - `'retained'`: the room still holds a seat for this account (a started match, or a reservation it
   *   will not release for anyone but a participant). The pairing stays claimable (`ready`) so neither
   *   account can be handed a second seat, and the caller must not report success.
   * - `'failed'`: the room could not be reached, so nothing may be concluded. `cleanup` stays set and
   *   the alarm retries.
   *
   * A `false` answer alone cannot decide this: the room also answers `false` for a private room's
   * matchmaking allocation and for an account it no longer knows, so the reservation state is
   * authoritative and its absence is treated as "still held" only when the room actually says so.
   */
  private async releaseRoom(roomId: string, userId: string): Promise<RoomOutcome> {
    let released: boolean;
    try {
      released = await roomStub(this.scope.env, roomId).cancelReservation(userId);
    } catch (error) {
      console.error(
        'matchmaker: reservation cleanup failed',
        error instanceof Error ? error.message : error,
      );
      return 'failed';
    }
    if (released) {
      this.clearCleanup(roomId);
      return 'released';
    }
    const reservation = await probeReservation(this.scope.env, roomId);
    if (reservation === 'none' || reservation === 'cancelled' || reservation === 'expired') {
      this.clearCleanup(roomId);
      return 'released';
    }
    if (reservation === 'unreachable') {
      console.error('matchmaker: reservation state unknown after a refused release', roomId);
      return 'failed';
    }
    this.scope.sql.exec(
      "UPDATE pairing SET state = 'ready', cleanup = 0 WHERE room_id = ? AND state = 'released'",
      roomId,
    );
    return 'retained';
  }

  private clearCleanup(roomId: string): void {
    this.scope.sql.exec('UPDATE pairing SET cleanup = 0 WHERE room_id = ?', roomId);
  }

  private hasLivePairing(userId: string, now: number): boolean {
    return (
      this.scope.sql
        .exec<{ room_id: string }>(
          'SELECT room_id FROM pairing WHERE (user_a = ? OR user_b = ?) AND state != ? AND expires_at > ? LIMIT 1',
          userId,
          userId,
          'released',
          now,
        )
        .toArray().length > 0
    );
  }

  private nextQueueExpiry(): number | null {
    const row = this.scope.sql
      .exec<{ next: number | null }>(
        'SELECT MIN(expires) AS next FROM (SELECT expires_at AS expires FROM waiting UNION ALL SELECT expires_at AS expires FROM pairing)',
      )
      .one();
    return row.next;
  }
}
