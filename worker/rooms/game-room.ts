import { DurableObject } from 'cloudflare:workers';
import {
  MAX_MESSAGE_BYTES,
  RESERVATION_TTL_MS,
  WS_CLOSE,
  WS_PROTOCOL,
} from '../../shared/protocol';
import type { ReservationState, RoomInit, RoomSnapshot, User } from '../../shared/protocol';
import { clientMessageSchema, roomInitSchema } from '../../shared/validation';
import { registerSessionRoom } from '../auth/sessions';
import type { Env } from '../env';
import { handleClientFrame } from './frames';
import { manualLeave } from './leave';
import { maybeAutoStart } from './match';
import { RoomRejection } from './rejection';
import {
  cancelReservation as releaseReservation,
  reservationState as readReservationState,
} from './reservation';
import {
  MAX_CATCHUP_STEPS,
  MESSAGE_LENGTH_FAST_PATH,
  MATCH_ACTIVE,
  SEAT_TTL_MS,
  duelIsOngoing,
  reservationIsGone,
} from './rules';
import { InputBudget } from './scope';
import type { RoomScope } from './scope';
import { pushSnapshots, snapshotFor } from './snapshots';
import {
  PROTOCOL_REFRESH_MESSAGE,
  closeSocket,
  currentProtocolSocket,
  dropSessionRef,
  readSocketAuth,
  readSocketMeta,
  reconcileHost,
  rejectStaleSocket,
  sendTo,
  sweepStaleProtocolSockets,
  unbindSocket,
} from './sockets';
import type { SocketAuth } from './sockets';
import { createSchema } from './storage/schema';
import { abandonedMatch } from './storage/departures';
import { getPlayer, insertPlayer, updatePlayer } from './storage/players';
import { getRoom, insertRoom } from './storage/room';
import { scheduleAlarm } from './timers';
import { advanceOnce } from './transitions';

/** A refused handshake, returned as a value so nothing is ever thrown out of a critical section. */
type HandshakeRefusal = { status: number; message: string };

/**
 * Authoritative room: one instance per room, SQLite-backed, WebSocket
 * hibernation safe. Every phase transition is driven by persisted deadlines and
 * the single alarm; nothing about the match lives only in memory.
 *
 * The match itself is continuous survival combat: one immutable ordered spell
 * book per match, a private spell cursor per seat, a single 3s opening countdown,
 * then one 240s combat phase whose deadline is set once and never extends.
 *
 * This class is the platform adapter — Durable Object lifecycle, RPC surface and
 * WebSocket entry points — and every room decision lives in this directory's
 * own modules behind the `RoomScope` seam.
 */
export class GameRoom extends DurableObject<Env> {
  private readonly scope: RoomScope;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.scope = {
      env,
      sql: ctx.storage.sql,
      input: new InputBudget(),
      alarm: { set: (when) => ctx.storage.setAlarm(when), clear: () => ctx.storage.deleteAlarm() },
      sockets: () => ctx.getWebSockets(),
      transactionSync: (callback) => ctx.storage.transactionSync(callback),
    };
    void ctx.blockConcurrencyWhile(async () => {
      // The room's own database, opened once per instance. A database already in
      // this layout is left exactly as it is, live match and queued rows included;
      // one upgrade either lands whole or aborts this wake-up — never half a schema
      // under a live match.
      this.scope.transactionSync(() => createSchema(ctx.storage.sql));
      // Attachments persisted by an older build wake up with the instance. Strip,
      // tell and close them once, then reconcile the room they can no longer act
      // on — the trio here, not per socket, and never left to a close callback
      // the early unbind has already bypassed.
      if (sweepStaleProtocolSockets(this.scope) > 0) {
        reconcileHost(this.scope);
        pushSnapshots(this.scope);
        await scheduleAlarm(this.scope);
      }
    });
  }

  // ---------------------------------------------------------------- RPC

  /**
   * Creates the room. All persisted state is written synchronously before any
   * external await, so a wake-up can never observe a half-created room.
   */
  async initialize(init: RoomInit): Promise<void> {
    const parsed = roomInitSchema.safeParse(init);
    if (!parsed.success)
      throw new Error(`room:invalid_init:${parsed.error.issues[0]?.path.join('.') || 'shape'}`);
    const { id, host, theme, mode } = parsed.data;
    const sql = this.scope.sql;
    const now = Date.now();
    const existing = getRoom(sql);
    if (existing) {
      if (existing.id !== id || existing.mode !== mode) throw new Error('room:already_initialized');
      return;
    }

    // The host legitimately appears in `reserved` for quick rooms, so the host
    // is not counted twice; anything else duplicated is a caller bug.
    const roster: User[] = [
      host,
      ...(parsed.data.reserved ?? []).filter((entry) => entry.id !== host.id),
    ];
    const seatExpiresAt = mode === 'quick' ? now + RESERVATION_TTL_MS : now + SEAT_TTL_MS;
    insertRoom(sql, {
      id,
      hostId: host.id,
      mode,
      theme,
      // Every room is hard: no request can choose a difficulty any more.
      difficulty: 'hard',
      reservationState: mode === 'quick' ? 'reserved' : 'none',
      reservationExpiresAt: mode === 'quick' ? now + RESERVATION_TTL_MS : null,
      now,
    });
    for (const entry of roster) {
      insertPlayer(sql, {
        userId: entry.id,
        username: entry.username,
        slotExpiresAt: seatExpiresAt,
        now,
      });
    }

    await scheduleAlarm(this.scope);
  }

  async snapshot(user: User): Promise<RoomSnapshot> {
    return snapshotFor(this.scope, user);
  }

  async reservationState(): Promise<ReservationState> {
    return readReservationState(this.scope);
  }

  /**
   * The public activity answer: is a duel being fought in this room right now? A boolean only —
   * no room id, roster, theme or phase detail ever crosses this boundary.
   */
  async activeDuel(): Promise<boolean> {
    const room = getRoom(this.scope.sql);
    return room !== null && duelIsOngoing(room, Date.now());
  }

  async cancelReservation(userId: string): Promise<boolean> {
    return releaseReservation(this.scope, userId);
  }

  /**
   * The account's explicit manual departure. Commits the forfeit or membership
   * release durably before returning; idempotent for a replayed leave, and a
   * `room:not_found` refusal for a room or seat this account never held. This
   * is the only path that forfeits: an ordinary disconnect never reaches it.
   */
  async leaveRoom(userId: string): Promise<void> {
    await manualLeave(this.scope, userId);
  }

  /**
   * True while this account still holds a live seat in the room's running match.
   * A match this account explicitly abandoned does not entitle it any more, so
   * the matchmaker releases the ticket on its next reconciliation even while
   * everyone else keeps playing — the room phase alone was never the question.
   */
  async matchEntitlement(userId: string): Promise<boolean> {
    const room = getRoom(this.scope.sql);
    if (!room || !MATCH_ACTIVE[room.phase]) return false;
    if (!getPlayer(this.scope.sql, userId)) return false;
    return !abandonedMatch(this.scope.sql, userId, room.match_id);
  }

  /**
   * Stops every socket authenticated by this session token. The auth layer calls
   * this before it answers a logout, so a revoked session takes effect while the
   * HTTP response is still being written rather than at the token's expiry.
   *
   * Every matching attachment loses its authority, including one that is already
   * closing: a queued frame is authorized by the seat's `conn_id`, not by the
   * socket's state, so only the sending/close step below is limited to open
   * sockets. Seats are detached before that step and before any await, so a frame
   * already queued for a revoked connection can no longer act on the match, and
   * nothing that follows pushes state to a revoked socket.
   */
  async revokeSession(sessionHash: string): Promise<void> {
    const scope = this.scope;
    const room = getRoom(scope.sql);
    const doomed: { ws: WebSocket; meta: SocketAuth }[] = [];
    for (const ws of scope.sockets()) {
      const meta = readSocketMeta(ws);
      if (meta && meta.sessionHash === sessionHash) doomed.push({ ws, meta });
    }
    if (doomed.length === 0) return;
    // Authority first, synchronously: every matching attachment — including one
    // that is already closing, whose queued frames are still authorized by the
    // seat's conn_id — loses it before any await or close.
    for (const { meta } of doomed) unbindSocket(scope, meta);
    let closeFailure: unknown = null;
    for (const { ws } of doomed) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.close(WS_CLOSE.sessionExpired, 'session revoked');
      } catch (error) {
        closeFailure ??= error;
      }
    }
    // Close before reconciling: the live roster only drops a socket once its
    // close is observed, so reconciling first would leave the room hosted by a
    // connection that can no longer act, and the early return that follows a
    // failed release would never re-run reconciliation.
    reconcileHost(scope);
    pushSnapshots(scope);
    // The auth layer answers the logout only once every room confirms, so a
    // socket that is still open must fail this call instead of passing silently.
    if (closeFailure !== null || doomed.some(({ ws }) => ws.readyState === WebSocket.OPEN)) {
      console.error(
        '[room] revocation incomplete',
        room?.id ?? '',
        closeFailure instanceof Error ? closeFailure.name : typeof closeFailure,
      );
      throw new Error('room:revoke_incomplete');
    }
    await scheduleAlarm(scope);
  }

  // ------------------------------------------------------------ WebSocket

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return Response.json({ error: '需要 WebSocket 升级请求。' }, { status: 400 });
    }
    // The Worker's route checks this first; the room repeats it because it is the
    // boundary that actually speaks v2. A handshake that cannot name the protocol
    // never becomes a socket an old client could act on.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
      .split(',')
      .map((value) => value.trim());
    if (!offered.includes(WS_PROTOCOL)) {
      return Response.json(
        { error: PROTOCOL_REFRESH_MESSAGE, protocolVersion: WS_PROTOCOL },
        { status: 426 },
      );
    }

    let auth: SocketAuth;
    try {
      auth = readSocketAuth(request);
    } catch (error) {
      if (error instanceof RoomRejection)
        return Response.json({ error: error.userMessage }, { status: error.status });
      throw error;
    }

    const scope = this.scope;
    const sql = scope.sql;
    const room = getRoom(sql);
    if (!room) return Response.json({ error: '房间不存在或已结束。' }, { status: 404 });
    const claimedRoomId = request.headers.get('x-room-id');
    if (claimedRoomId !== null && claimedRoomId !== room.id)
      return Response.json({ error: '房间不存在或已结束。' }, { status: 404 });
    if (reservationIsGone(room, Date.now())) {
      return Response.json({ error: '匹配已结束，请重新匹配。' }, { status: 409 });
    }
    // An explicitly abandoned match never readmits the account that left it — not
    // after a delayed generation continuation, not on a stale tab, not ever while
    // this match is the room's current one. An ordinary disconnect bypasses this:
    // only a committed departure writes the record the check reads.
    if (getPlayer(sql, auth.userId) && abandonedMatch(sql, auth.userId, room.match_id)) {
      return Response.json({ error: '你已离开本场对局。' }, { status: 409 });
    }

    // Nothing below awaited yet, so `room` is still the state this handshake
    // starts from.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(auth);

    // One critical section owns the whole handshake: the session reference, the
    // seat and the new connection become authoritative together, so a logout, a
    // seat change or a concurrent start can never observe half of it. Nothing is
    // ever thrown out of the callback — a rejected critical section is a fatal
    // room error, so a refused join must be a value, not an exception.
    const refusal = await this.ctx.blockConcurrencyWhile<HandshakeRefusal | null>(async () => {
      try {
        if (!(await registerSessionRoom(scope.env, auth.sessionHash, room.id))) {
          return { status: 403, message: '登录状态已失效，请重新登录。' };
        }
        if (!getPlayer(sql, auth.userId)) {
          if (room.mode === 'quick') return { status: 409, message: '匹配已结束，请重新匹配。' };
          if (room.locked !== 0 || room.phase !== 'lobby')
            return { status: 409, message: '比赛已开始，无法加入。' };
          const seated = insertPlayer(sql, {
            userId: auth.userId,
            username: auth.username,
            slotExpiresAt: Date.now() + SEAT_TTL_MS,
            now: Date.now(),
          });
          if (!seated) return { status: 409, message: '房间已满。' };
        }
        this.ctx.acceptWebSocket(server);
        // A newer connection supersedes older sockets of the same account; their
        // close events are ignored later via conn_id, so they cannot mark the new
        // connection as disconnected.
        for (const other of this.ctx.getWebSockets()) {
          if (other === server) continue;
          const meta = readSocketMeta(other);
          if (meta && meta.userId === auth.userId)
            closeSocket(other, WS_CLOSE.replaced, 'replaced by a newer connection');
        }
        // The seat's live connection is bound inside the same section that
        // registered and accepted it, so a revocation sweep can never see an open
        // socket that the seat does not yet point at.
        updatePlayer(sql, auth.userId, { conn_id: auth.connId, slot_expires_at: null, seated: 1 });
        reconcileHost(scope);
        maybeAutoStart(scope, getRoom(sql) ?? room);
        return null;
      } catch (error) {
        // A storage or provider hiccup must cost one handshake, not the room.
        console.error(
          '[room] handshake failed',
          room.id,
          error instanceof Error ? error.name : typeof error,
        );
        return { status: 500, message: '服务器内部错误' };
      }
    });
    if (refusal !== null)
      return Response.json({ error: refusal.message }, { status: refusal.status });

    pushSnapshots(scope);
    await scheduleAlarm(scope);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': WS_PROTOCOL },
    });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const meta = readSocketMeta(ws);
    if (!meta) {
      try {
        ws.close(1008, 'unknown connection');
      } catch {
        // Socket already gone; nothing to clean up.
      }
      return;
    }
    // An attachment persisted by an older build may deliver its first frame after
    // this instance woke: parse nothing from a protocol this room does not speak.
    // Strip its authority first, then the usual trio — the close callback will
    // find the seat already unbound and skip them.
    if (!currentProtocolSocket(meta)) {
      rejectStaleSocket(this.scope, ws, meta);
      reconcileHost(this.scope);
      pushSnapshots(this.scope);
      await scheduleAlarm(this.scope);
      return;
    }
    if (typeof message !== 'string') {
      sendTo(ws, { type: 'error', message: '不支持的消息格式。' });
      return;
    }
    if (
      message.length > MAX_MESSAGE_BYTES ||
      (message.length > MESSAGE_LENGTH_FAST_PATH &&
        new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES)
    ) {
      sendTo(ws, { type: 'error', message: '消息过大。' });
      return;
    }
    if (meta.sessionExpires <= Date.now()) {
      sendTo(ws, { type: 'error', message: '登录状态已过期，请重新登录。' });
      closeSocket(ws, WS_CLOSE.sessionExpired, 'session expired');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      sendTo(ws, { type: 'error', message: '消息格式错误。' });
      return;
    }
    // A v2-shaped input without the mandatory draft epoch is an old client in
    // everything but its self-declared version: cut it off like one instead of
    // answering every packet with a generic schema error. Any other invalid v2
    // data stays an ordinary schema rejection below.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'input' &&
      !('draftEpoch' in parsed)
    ) {
      rejectStaleSocket(this.scope, ws, meta);
      reconcileHost(this.scope);
      pushSnapshots(this.scope);
      await scheduleAlarm(this.scope);
      return;
    }
    const clientMessage = clientMessageSchema.safeParse(parsed);
    if (!clientMessage.success) {
      sendTo(ws, { type: 'error', message: '消息格式错误。' });
      return;
    }

    try {
      await handleClientFrame(this.scope, ws, meta, clientMessage.data);
    } catch (error) {
      console.error(
        '[room] message handling failed',
        clientMessage.data.type,
        error instanceof Error ? error.message : typeof error,
      );
      sendTo(ws, { type: 'error', message: '服务器处理失败，请重试。' });
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.handleSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[room] socket error', error instanceof Error ? error.name : typeof error);
    await this.handleSocketGone(ws);
  }

  private async handleSocketGone(ws: WebSocket): Promise<void> {
    const meta = readSocketMeta(ws);
    if (!meta) return;
    const scope = this.scope;
    const released = unbindSocket(scope, meta);
    // Dropping this room's reference to the session is checked and written inside
    // the same critical section that accepts connections, so a connection that
    // re-registers this session cannot slip its insert in front of this delete and
    // have its reference erased. It runs on every close branch — including a
    // superseded socket, whose replacement still needs the reference — and only
    // when no socket here still holds that session open, so a revocation this room
    // has not confirmed keeps its retry target. The helper never throws: a close
    // path must not be able to reject a critical section.
    await this.ctx.blockConcurrencyWhile(async () => {
      await dropSessionRef(scope, meta.sessionHash, ws);
    });
    if (!released) return;
    reconcileHost(scope);
    pushSnapshots(scope);
    await scheduleAlarm(scope);
  }

  // ---------------------------------------------------------------- Alarm

  async alarm(): Promise<void> {
    for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
      const progressed = await advanceOnce(this.scope);
      if (!progressed) break;
    }
    await scheduleAlarm(this.scope);
  }
}
