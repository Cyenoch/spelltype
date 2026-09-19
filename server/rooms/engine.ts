import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rooms } from '../db/schema';
import { WS_CLOSE, WS_CLOSE_RESTART } from '../../shared/protocol';
import type { RoomSocket, RoomSocketData } from '../contracts';
import type { AuthenticatedSession } from '../contracts';
import { clientMessageSchema } from '../../shared/validation';
import { MAX_MESSAGE_BYTES } from '../../shared/protocol';
import { RoomRejection } from './rejection';
import { SEAT_TTL_MS, MESSAGE_LENGTH_FAST_PATH, MAX_CATCHUP_STEPS } from './rules';
import { reservationIsGone } from './rules';
import { createRoomScope, InputBudget, SocketRegistry } from './scope';
import type { RoomScope, SocketAuth } from './scope';
import { pushSnapshots } from './snapshots';
import {
  closeAllSockets,
  closeSocket,
  currentProtocolSocket,
  dropSessionRef,
  reconcileHost,
  rejectStaleSocket,
  sendTo,
  unbindSeat,
} from './sockets';
import { abandonedMatch } from './storage/departures';
import { getPlayer, insertPlayer, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { registerSessionRoom } from './storage/room-sessions';
import { armRoom } from './timers';
import { advanceOnce } from './transitions';
import { applyGenerationOutcome } from './spellbook';
import { handleClientFrame } from './frames';
import { manualLeave } from './leave';
import { maybeAutoStartTx } from './match';
import { reservationStateOf, endReservation } from './reservation';
import type { RoomRuntime } from './runtime';

/** One refused join, delivered in-band after the HTTP upgrade has already succeeded. */
type JoinRefusal = { closeCode: number; message: string };

/**
 * One room's live engine: its sockets, its serialized command queue and its
 * timer. Every mutation — a frame, a join, a catch-up pass, a revocation —
 * enters the queue, so two commands never interleave for the same room, and
 * each command's state changes commit in fenced transactions.
 */
export class RoomEngine {
  readonly registry = new SocketRegistry();
  readonly input = new InputBudget();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  readonly scope: RoomScope;

  constructor(
    private readonly runtime: RoomRuntime,
    readonly roomId: string,
  ) {
    this.scope = createRoomScope({
      roomId,
      db: runtime.database,
      generate: runtime.generate,
      registry: this.registry,
      input: this.input,
      inputPolicyMode: runtime.inputPolicyMode,
      transact: (fn) =>
        this.runtime.database.transaction(async (tx) => {
          // The ownership fence is the first statement of every mutation
          // transaction, so a late owner cannot write after its lease is lost:
          // it locks runtime_control (admission and ownership) before any room
          // row. The room itself is locked too, so every command's state
          // changes serialize per room under a held fence.
          await this.runtime.assertOwnership(tx);
          const owned = await tx
            .select({ id: rooms.id })
            .from(rooms)
            .where(eq(rooms.id, roomId))
            .for('update')
            .limit(1);
          if (owned[0] === undefined)
            throw new RoomRejection('room:not_found', '房间不存在或已结束。');
          return fn(tx);
        }),
      push: (scope) => pushSnapshots(scope),
      arm: (scope) =>
        armRoom(scope, (when) => {
          this.setTimer(when);
        }),
    });
  }

  /** Serializes every room command; FIFO order preserves open → frames → close. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------- socket events

  /** Adopts one upgraded socket: metadata and event wiring land before any frame can arrive. */
  connect(data: RoomSocketData, socket: RoomSocket): void {
    if (this.stopped) {
      closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
      return;
    }
    const auth: SocketAuth = {
      userId: data.session.user.id,
      username: data.session.user.username,
      connId: randomUUID(),
      sessionHash: data.session.tokenHash,
      sessionExpires: data.session.expiresAt,
      protocolVersion: data.protocolVersion,
    };
    this.registry.attach(socket, auth);
    void this.enqueue(async () => {
      if (this.stopped) {
        closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
        return;
      }
      try {
        // An attachment that cannot name this build's wire protocol never joins:
        // it is told once and cut off, and the room reconciles around its loss.
        if (!currentProtocolSocket(auth)) {
          await rejectStaleSocket(this.scope, socket, auth);
          await this.afterSocketCut();
          return;
        }
        await this.join(data.session, socket, auth);
      } catch (error) {
        console.error(
          '[room] join failed',
          this.roomId,
          error instanceof Error ? error.message : typeof error,
        );
        sendTo(socket, { type: 'error', message: '服务器内部错误' });
        closeSocket(socket, WS_CLOSE.closed, 'join failed');
      }
    });
  }

  /** Routes one frame into the room's queue; nothing is lost while a join is still pending. */
  message(socket: RoomSocket, raw: string | Uint8Array): void {
    void this.enqueue(async () => {
      const meta = this.registry.metaOf(socket);
      if (!meta) {
        closeSocket(socket, 1008, 'unknown connection');
        return;
      }
      // An attachment that does not speak this build's protocol may deliver a
      // queued frame: parse nothing from a protocol this room does not speak.
      // Strip its authority first, then the usual trio — the close callback
      // will find the seat already unbound and skip them.
      if (!currentProtocolSocket(meta)) {
        await rejectStaleSocket(this.scope, socket, meta);
        await this.afterSocketCut();
        return;
      }
      if (typeof raw !== 'string') {
        sendTo(socket, { type: 'error', message: '不支持的消息格式。' });
        return;
      }
      if (
        raw.length > MAX_MESSAGE_BYTES ||
        (raw.length > MESSAGE_LENGTH_FAST_PATH &&
          new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES)
      ) {
        sendTo(socket, { type: 'error', message: '消息过大。' });
        return;
      }
      if (meta.sessionExpires <= Date.now()) {
        sendTo(socket, { type: 'error', message: '登录状态已过期，请重新登录。' });
        closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendTo(socket, { type: 'error', message: '消息格式错误。' });
        return;
      }
      // An input without the mandatory draft epoch is an old client in
      // everything but its self-declared version: cut it off like one instead of
      // answering every packet with a generic schema error. Any other invalid
      // data stays an ordinary schema rejection below.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        parsed.type === 'input' &&
        !('draftEpoch' in parsed)
      ) {
        await rejectStaleSocket(this.scope, socket, meta);
        await this.afterSocketCut();
        return;
      }
      const clientMessage = clientMessageSchema.safeParse(parsed);
      if (!clientMessage.success) {
        sendTo(socket, { type: 'error', message: '消息格式错误。' });
        return;
      }
      try {
        await handleClientFrame(this.scope, socket, meta, clientMessage.data);
      } catch (error) {
        console.error(
          '[room] message handling failed',
          clientMessage.data.type,
          error instanceof Error ? error.message : typeof error,
        );
        sendTo(socket, { type: 'error', message: '服务器处理失败，请重试。' });
      }
    });
  }

  /** Cleans up one closed socket; the queue serializes this against concurrent joins. */
  disconnect(socket: RoomSocket): void {
    const meta = this.registry.detach(socket);
    if (!meta) return;
    this.input.release(meta.connId);
    void this.enqueue(async () => {
      if (this.stopped) return;
      const now = Date.now();
      const released = await this.scope.transact(async (tx) => {
        const unbound = await unbindSeat(tx, this.roomId, meta, now);
        // Dropping this room's reference to the session is checked and written
        // inside the same transaction that accepts connections, so a connection
        // that re-registers this session cannot slip its insert in front of
        // this delete and have its reference erased.
        await dropSessionRef(tx, this.roomId, this.registry, meta.sessionHash, socket);
        return unbound;
      });
      if (!released) return;
      await this.scope.transact(async (tx) => reconcileHost(tx, this.roomId, this.registry));
      await pushSnapshots(this.scope);
      await this.arm();
    });
  }

  // ----------------------------------------------------------------- join flow

  /**
   * The authoritative join. The session reference, the seat and the new
   * connection become authoritative inside one fenced transaction, so a
   * logout, a seat change or a concurrent start can never observe half of it.
   * A refused join is delivered in-band — an error frame and a close — because
   * the HTTP upgrade has already succeeded.
   */
  private async join(
    session: AuthenticatedSession,
    socket: RoomSocket,
    auth: SocketAuth,
  ): Promise<void> {
    const refusal = await this.scope.transact(async (tx): Promise<JoinRefusal | null> => {
      // Registration loses the race against a logout exactly once: the single
      // conditional statement only accepts a live session row.
      if (!(await registerSessionRoom(tx, session.tokenHash, this.roomId))) {
        return { closeCode: WS_CLOSE.sessionExpired, message: '登录状态已失效，请重新登录。' };
      }
      const room = await getRoom(tx, this.roomId);
      if (!room) {
        return { closeCode: WS_CLOSE.closed, message: '房间不存在或已结束。' };
      }
      if (reservationIsGone(room, Date.now())) {
        return { closeCode: WS_CLOSE.closed, message: '匹配已结束，请重新匹配。' };
      }
      if (await abandonedMatch(tx, this.roomId, auth.userId, room.match_id)) {
        // An explicitly abandoned match never readmits the account that left it —
        // not after a delayed generation continuation, not on a stale tab.
        return { closeCode: WS_CLOSE.closed, message: '你已离开本场对局。' };
      }

      if (!(await getPlayer(tx, this.roomId, auth.userId))) {
        if (room.mode === 'quick') {
          return { closeCode: WS_CLOSE.closed, message: '匹配已结束，请重新匹配。' };
        }
        if (room.locked !== 0 || room.phase !== 'lobby') {
          return { closeCode: WS_CLOSE.closed, message: '比赛已开始，无法加入。' };
        }
        const seated = await insertPlayer(tx, this.roomId, {
          userId: auth.userId,
          username: auth.username,
          slotExpiresAt: Date.now() + SEAT_TTL_MS,
          now: Date.now(),
        });
        if (!seated) {
          return { closeCode: WS_CLOSE.closed, message: '房间已满。' };
        }
      }

      // A newer connection supersedes older sockets of the same account; their
      // close events are ignored later via conn_id, so they cannot mark the
      // new connection as disconnected.
      for (const other of this.registry.list()) {
        if (other === socket) continue;
        const otherMeta = this.registry.metaOf(other);
        if (otherMeta && otherMeta.userId === auth.userId)
          closeSocket(other, WS_CLOSE.replaced, 'replaced by a newer connection');
      }
      // The seat's live connection is bound inside the same transaction that
      // registered and accepted it, so a revocation sweep can never see an
      // open socket that the seat does not yet point at.
      await updatePlayer(tx, this.roomId, auth.userId, {
        conn_id: auth.connId,
        slot_expires_at: null,
        seated: 1,
      });
      await reconcileHost(tx, this.roomId, this.registry);
      await maybeAutoStartTx(tx, this.roomId, this.registry, room, this.scope.inputPolicyMode);
      return null;
    });

    if (refusal !== null) {
      sendTo(socket, { type: 'error', message: refusal.message });
      closeSocket(socket, refusal.closeCode, 'join refused');
      return;
    }
    await pushSnapshots(this.scope);
    await this.arm();
  }

  // ------------------------------------------------------------ external state

  /**
   * Re-reads the room's committed state and reconciles what the engine cannot
   * see by itself: a reservation the matchmaker cancelled in the database, a
   * pairing whose TTL lapsed, a room row that is gone.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const room = await getRoom(this.scope.db, this.roomId);
      if (!room) {
        closeAllSockets(this.registry, WS_CLOSE.closed, 'room gone');
        this.setTimer(null);
        return;
      }
      if (
        room.mode === 'quick' &&
        (room.reservation_state === 'cancelled' || room.reservation_state === 'expired')
      ) {
        // The coordination layer cancelled or expired this pairing in the
        // database. Mirror the reservation ending the room itself would have
        // performed: if seats remain, the room tells them the reason and then
        // closes their connections; if the seats are already gone, only the
        // stale connections are closed.
        const state = room.reservation_state;
        const ended = await endReservation(this.scope, state, RESERVATION_MESSAGES[state]);
        if (!ended) closeAllSockets(this.registry, WS_CLOSE.closed, state);
        await this.arm();
        return;
      }
      if (
        room.mode === 'quick' &&
        room.reservation_state === 'reserved' &&
        reservationStateOf(room, Date.now()) === 'expired'
      ) {
        await endReservation(this.scope, 'expired', RESERVATION_MESSAGES.expired);
        await this.arm();
        return;
      }
      await pushSnapshots(this.scope);
      await this.arm();
    });
  }

  /** Runs the due-transition catch-up loop; the timer rearms from persisted state. */
  catchup(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      try {
        for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
          const outcome = await advanceOnce(this.scope);
          if (outcome.generation !== undefined) {
            // The attempt continues outside the queue; it clears its own
            // in-flight marker and rearms the timer when it settles.
            void this.runGeneration(outcome.generation);
            break;
          }
          if (!outcome.progressed) break;
        }
      } finally {
        await this.arm();
      }
    }).catch((error) => {
      // A failed transition (database outage) retries with a bounded floor
      // instead of hammering; a failed catch-up never loses the deadline,
      // which lives in the room row.
      console.error(
        '[room] catch-up failed',
        this.roomId,
        error instanceof Error ? error.message : typeof error,
      );
      return this.retryAfterFailure();
    });
  }

  /**
   * Leaves the room for one account; rethrows the room's own refusals to the
   * caller so the HTTP layer can map them.
   */
  leaveRoom(userId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
      await manualLeave(this.scope, userId);
      await this.arm();
    });
  }

  /**
   * Stops every socket authenticated by this session token. Authority first,
   * synchronously: every matching attachment — including one that is already
   * closing, whose queued frames are still authorized by the seat's conn_id —
   * loses it before any close. The caller answers the logout only once every
   * room confirms, so a socket that is still open must fail this call instead
   * of passing silently.
   */
  revokeSession(tokenHash: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.stopped) return true;
      const doomed: { socket: RoomSocket; meta: SocketAuth }[] = [];
      for (const socket of this.registry.list()) {
        const meta = this.registry.metaOf(socket);
        if (meta && meta.sessionHash === tokenHash) doomed.push({ socket, meta });
      }
      if (doomed.length === 0) return true;
      for (const { meta } of doomed) this.input.release(meta.connId);
      await this.scope.transact(async (tx) => {
        const now = Date.now();
        for (const { meta } of doomed) await unbindSeat(tx, this.roomId, meta, now);
        await reconcileHost(tx, this.roomId, this.registry);
      });
      let closeFailure: unknown = null;
      for (const { socket } of doomed) {
        if (socket.readyState !== 1) continue;
        try {
          socket.close(WS_CLOSE.sessionExpired, 'session revoked');
        } catch (error) {
          closeFailure ??= error;
        }
      }
      await pushSnapshots(this.scope);
      if (closeFailure !== null || doomed.some(({ socket }) => socket.readyState === 1)) {
        console.error(
          '[room] revocation incomplete',
          this.roomId,
          closeFailure instanceof Error ? closeFailure.name : typeof closeFailure,
        );
        return false;
      }
      await this.arm();
      return true;
    });
  }

  // -------------------------------------------------------------------- timers

  private setTimer(when: number | null): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (when === null || this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.catchup();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, when - Date.now())),
    );
  }

  private async arm(): Promise<void> {
    await armRoom(this.scope, (when) => this.setTimer(when));
  }

  /**
   * The reconcile/snapshot/alarm trio that follows a socket whose authority was
   * stripped early (stale protocol, input overload): the close callback finds
   * the seat already unbound and skips them, so they run here instead — once
   * per cut, not per socket.
   */
  private async afterSocketCut(): Promise<void> {
    await this.scope.transact((tx) => reconcileHost(tx, this.roomId, this.registry));
    await pushSnapshots(this.scope);
    await this.arm();
  }

  private async retryAfterFailure(): Promise<void> {
    if (this.stopped) return;
    const retryAt = Date.now() + CATCHUP_RETRY_MS;
    try {
      await this.scope.transact(async (tx) => {
        await updateRoom(tx, this.roomId, { next_alarm_at: retryAt });
      });
    } catch {
      // The retry row is a hint only; the in-memory timer below still fires.
    }
    this.setTimer(retryAt);
  }

  // --------------------------------------------------------------- generation

  /**
   * Runs one claimed generation attempt outside the command queue: the long
   * provider await blocks nothing, and the result re-enters as a serialized
   * command that re-validates the match token before it touches state.
   */
  private async runGeneration(token: string): Promise<void> {
    // Set before the first await: the catch-up pass that starts this attempt
    // rearms timers right after, and the flag must already mark the attempt
    // as locally owned or the rearm would read as a crashed claim.
    this.scope.inFlightGeneration = token;
    try {
      const room = await getRoom(this.scope.db, this.roomId);
      if (!room || room.phase !== 'generating' || room.generation_token !== token) {
        this.scope.inFlightGeneration = null;
        return;
      }
      const outcome = await this.runtime.generate({
        theme: room.theme,
        variation: `${room.match_id ?? ''}:${room.generation_seq}`,
      });
      await this.enqueue(async () => {
        this.scope.inFlightGeneration = null;
        if (this.stopped) return;
        try {
          await applyGenerationOutcome(this.scope, token, outcome);
          await this.arm();
        } catch (error) {
          console.error(
            '[room] generation apply failed',
            this.roomId,
            error instanceof Error ? error.message : typeof error,
          );
          await this.retryAfterFailure();
        }
      });
    } catch (error) {
      this.scope.inFlightGeneration = null;
      console.error(
        '[room] generation attempt failed',
        this.roomId,
        error instanceof Error ? error.message : typeof error,
      );
      await this.enqueue(async () => {
        if (this.stopped) return;
        await this.retryAfterFailure();
      });
    }
  }

  // ------------------------------------------------------------------ shutdown

  /** Stops the timer and closes every socket with the recoverable restart code. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.setTimer(null);
    for (const socket of this.registry.list())
      closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
    await this.tail;
  }
}

const CATCHUP_RETRY_MS = 2_000;
// Longer deadlines wake at this ceiling and re-arm against their original timestamp.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The reasons a cancelled or expired pairing carries to its seats. */
const RESERVATION_MESSAGES: Record<'cancelled' | 'expired', string> = {
  cancelled: '匹配已取消，请重新匹配。',
  expired: '匹配超时，请重新匹配。',
};
