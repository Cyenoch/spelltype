import { DurableObject } from 'cloudflare:workers';
import {
  MATCH_DURATION_MS,
  MAX_INPUT_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_PRIVATE_PLAYERS,
  MAX_THEME_CHARS,
  OPENING_COUNTDOWN_MS,
  RESERVATION_TTL_MS,
  WS_CLOSE,
} from '../shared/protocol';
import type {
  ClientMessage,
  CombatEvent,
  EndReason,
  Phase,
  Player,
  ReservationState,
  RoomInit,
  RoomSnapshot,
  ServerMessage,
  Spell,
  User,
} from '../shared/protocol';
import type { Env } from './env';
import { registerSessionRoom, unregisterSessionRoom } from './auth';
import { generateSpellSet } from './generation';
import { ROOM_ID_PATTERN } from './ids';
import * as store from './room-state';
import type { PlayerRow, ResultRow, RoomRow } from './room-state';
import { accuracyOf, charCount, cpmOf, damageOf, diffSnapshot, nextAliveBySeat, survivalRanks } from './scoring';

/** A never-connected/disconnected lobby seat is reclaimable this long after it went idle. */
const SEAT_TTL_MS = 120_000;

const MIN_PLAYERS = 2;
/** A JS string this many UTF-16 units long is always <= MAX_MESSAGE_BYTES UTF-8 bytes. */
const MESSAGE_LENGTH_FAST_PATH = Math.floor(MAX_MESSAGE_BYTES / 3);
const MAX_CATCHUP_STEPS = 32;
/** Result writes back off up to this delay and keep retrying: an outage may be long. */
const PERSIST_BACKOFF_CAP_MS = 60_000;
/**
 * How long a queued result write may stay in flight before another attempt is
 * allowed. Persisted before the D1 call, so a reset in the middle of a batch is
 * recovered by the alarm instead of leaving `saving` forever.
 */
const PERSIST_LEASE_MS = 30_000;
/** Coalesced snapshots from a human typist stay far below this. */
const INPUTS_PER_SECOND = 60;

const WS_OPEN = 1;

/** Phases whose `deadline` is an authoritative clock: the opening countdown, then the single combat end. */
const TIMED_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which a running match owns the seats and a reservation must not be released. */
const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which the generated book is public, so a seat can see its own current spell. */
const BOOK_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: true,
};

export type RoomRejectionCode = 'room:not_found' | 'room:full' | 'room:in_progress' | 'room:reservation_gone' | 'room:unauthenticated';

const REJECTION_STATUS: Record<RoomRejectionCode, number> = {
  'room:not_found': 404,
  'room:full': 409,
  'room:in_progress': 409,
  'room:reservation_gone': 409,
  'room:unauthenticated': 403,
};

/**
 * Thrown for every expected refusal. `message` is the machine-readable code so
 * the outer Worker can map it without string surgery; `userMessage` is what the
 * player is allowed to see.
 */
export class RoomRejection extends Error {
  readonly code: RoomRejectionCode;
  readonly status: number;
  readonly userMessage: string;

  constructor(code: RoomRejectionCode, userMessage: string) {
    super(code);
    this.name = 'RoomRejection';
    this.code = code;
    this.status = REJECTION_STATUS[code];
    this.userMessage = userMessage;
  }
}

type SocketAuth = {
  userId: string;
  username: string;
  connId: string;
  sessionHash: string;
  sessionExpires: number;
};

/** A refused handshake, returned as a value so nothing is ever thrown out of a critical section. */
type HandshakeRefusal = { status: number; message: string };

type SnapshotContext = {
  room: RoomRow;
  players: PlayerRow[];
  /** Parsed once per push and shared by every recipient's snapshot. */
  book: Spell[];
  events: CombatEvent[];
  /** The seats' current connection ids: the only sockets allowed to receive state. */
  conns: Set<string>;
  ranks: Map<string, number> | null;
  serverNow: number;
};

/**
 * The accounts a socket currently speaks for: a seat is online only while its
 * recorded `conn_id` matches a live socket, so a socket whose authority was
 * revoked, replaced or already released is not online even if its physical close
 * has not landed yet.
 */
function onlineUserIds(players: readonly PlayerRow[], conns: ReadonlySet<string>): Set<string> {
  const online = new Set<string>();
  for (const row of players) {
    if (row.conn_id !== null && conns.has(row.conn_id)) online.add(row.user_id);
  }
  return online;
}

function readSocketAuth(request: Request): SocketAuth {
  const sessionExpires = Number(request.headers.get('x-session-expires'));
  const userId = request.headers.get('x-user-id') ?? '';
  const sessionHash = request.headers.get('x-session-hash') ?? '';
  const rawUsername = (request.headers.get('x-username') ?? '').trim();
  // Display names travel percent-encoded (header values cannot carry non-Latin-1
  // bytes); a malformed value falls back to what the Worker sent.
  let username = rawUsername;
  try {
    username = decodeURIComponent(rawUsername);
  } catch {
    username = rawUsername;
  }
  if (userId.length === 0 || sessionHash.length === 0 || !Number.isFinite(sessionExpires)) {
    throw new RoomRejection('room:unauthenticated', '登录状态无效，请重新登录。');
  }
  if (sessionExpires <= Date.now()) {
    throw new RoomRejection('room:unauthenticated', '登录状态已过期，请重新登录。');
  }
  return { userId, username: username || userId, connId: crypto.randomUUID(), sessionHash, sessionExpires };
}

function readSocketMeta(ws: WebSocket): SocketAuth | null {
  const meta = ws.deserializeAttachment() as SocketAuth | null;
  if (!meta || typeof meta.userId !== 'string' || typeof meta.connId !== 'string') return null;
  return meta;
}

/** The generated, ordered spell book shared by every seat. */
function bookOf(room: RoomRow): Spell[] {
  if (!room.spell_book) return [];
  try {
    const parsed: unknown = JSON.parse(room.spell_book);
    return Array.isArray(parsed) ? (parsed as Spell[]) : [];
  } catch (error) {
    console.error('[room] unreadable spell book', room.id, error instanceof Error ? error.name : typeof error);
    return [];
  }
}

/**
 * A player's spell for a private, monotonic, zero-based index. The index wraps
 * around the book, so a match longer than the book repeats the same ordered
 * practice spells instead of running out of content; the length comes from the
 * stored book, which generation always fills with exactly SPELL_BOOK_SIZE spells.
 */
function spellAt(book: readonly Spell[], index: number): Spell | null {
  if (book.length === 0) return null;
  const wrapped = ((index % book.length) + book.length) % book.length;
  return book[wrapped];
}

function parseClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case 'ready':
      return typeof raw.ready === 'boolean' ? { type: 'ready', ready: raw.ready } : null;
    case 'start':
      return { type: 'start' };
    case 'input':
      return typeof raw.matchId === 'string' &&
        typeof raw.spellIndex === 'number' &&
        Number.isInteger(raw.spellIndex) &&
        raw.spellIndex >= 0 &&
        typeof raw.text === 'string'
        ? { type: 'input', matchId: raw.matchId, spellIndex: raw.spellIndex, text: raw.text }
        : null;
    case 'rematch':
      return { type: 'rematch' };
    case 'leave':
      return { type: 'leave' };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rejectionResponse(error: unknown): Response {
  if (error instanceof RoomRejection) return jsonError(error.status, error.userMessage);
  throw error;
}

/**
 * Authoritative room: one instance per room, SQLite-backed, WebSocket
 * hibernation safe. Every phase transition is driven by persisted deadlines and
 * the single alarm; nothing about the match lives only in memory.
 *
 * The match itself is continuous survival combat: one generated ordered spell
 * book per match, a private spell cursor per seat, a single 3s opening countdown,
 * then one 240s combat phase whose deadline is set once and never extends.
 */
export class GameRoom extends DurableObject<Env> {
  private readonly inputWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // A database that predates the combat layout is discarded and recreated
      // empty by this one-time migration; a database already in this layout is
      // left exactly as it is, live match and queued result rows included.
      store.migrate(ctx.storage.sql);
    });
  }

  // ---------------------------------------------------------------- RPC

  /**
   * Creates the room. All persisted state is written synchronously before any
   * external await, so a wake-up can never observe a half-created room.
   */
  async initialize(init: RoomInit): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const existing = store.getRoom(sql);
    if (existing) {
      if (existing.id !== init.id || existing.mode !== init.mode) throw new Error('room:already_initialized');
      return;
    }

    if (!ROOM_ID_PATTERN.test(init.id)) throw new Error('room:invalid_init:id');
    if (init.mode !== 'private' && init.mode !== 'quick') throw new Error('room:invalid_init:mode');
    if (init.difficulty !== 'easy' && init.difficulty !== 'normal' && init.difficulty !== 'hard') throw new Error('room:invalid_init:difficulty');
    if (typeof init.host?.id !== 'string' || init.host.id.length === 0) throw new Error('room:invalid_init:host');

    const theme = typeof init.theme === 'string' ? init.theme : '';
    if (theme.trim().length === 0 || charCount(theme) > MAX_THEME_CHARS || /[\u0000-\u001f\u007f]/.test(theme)) {
      throw new Error('room:invalid_init:theme');
    }

    // The host legitimately appears in `reserved` for quick rooms, so the host
    // is not counted twice; anything else duplicated is a caller bug.
    const reserved = init.reserved ?? [];
    if (reserved.some((entry) => typeof entry?.id !== 'string' || entry.id.length === 0)) throw new Error('room:invalid_init:roster');
    if (new Set(reserved.map((entry) => entry.id)).size !== reserved.length) throw new Error('room:invalid_init:roster');
    // `reserved` may list the partner alone (the host is implicit) or both
    // matched accounts; the roster is the host plus everyone else exactly once.
    const roster: User[] = [init.host, ...reserved.filter((entry) => entry.id !== init.host.id)];
    if (roster.length > MAX_PRIVATE_PLAYERS) throw new Error('room:invalid_init:roster');
    if (init.mode === 'quick' && roster.length !== 2) throw new Error('room:invalid_init:quick_roster');

    const seatExpiresAt = init.mode === 'quick' ? now + RESERVATION_TTL_MS : now + SEAT_TTL_MS;
    store.insertRoom(sql, {
      id: init.id,
      hostId: init.host.id,
      mode: init.mode,
      theme,
      difficulty: init.difficulty,
      reservationState: init.mode === 'quick' ? 'reserved' : 'none',
      reservationExpiresAt: init.mode === 'quick' ? now + RESERVATION_TTL_MS : null,
      now,
    });
    for (const entry of roster) {
      store.insertPlayer(sql, { userId: entry.id, username: entry.username, slotExpiresAt: seatExpiresAt, now });
    }

    await this.scheduleAlarm();
  }

  async snapshot(user: User): Promise<RoomSnapshot> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
    if (this.reservationIsGone(room, Date.now())) throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');

    const player = store.getPlayer(sql, user.id);
    if (!player) {
      if (room.mode === 'quick') throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');
      if (room.locked !== 0 || room.phase !== 'lobby') throw new RoomRejection('room:in_progress', '比赛已开始，无法加入。');
      if (store.countPlayers(sql) >= MAX_PRIVATE_PLAYERS) throw new RoomRejection('room:full', '房间已满。');
    }
    return this.buildSnapshot(this.snapshotContext(sql, room), user.id);
  }

  /**
   * Reservation state for matchmaking reconciliation. `reserved` means a live
   * pre-match reservation, `locked` means a match is generating or running, and
   * everything else (`none`, `cancelled`, `expired`) holds no allocation, so a
   * ticket can be dropped. A room id that was never initialized reads as `none`
   * rather than an error, and a reservation whose deadline passed reads as
   * `expired` even before the alarm that cleans it up has run.
   */
  async reservationState(): Promise<ReservationState> {
    const room = store.getRoom(this.ctx.storage.sql);
    if (!room) return 'none';
    if (room.mode === 'quick' && room.reservation_state === 'reserved' && !this.reservationIsLive(room, Date.now())) return 'expired';
    return room.reservation_state;
  }

  /**
   * Releases this account's matchmaking allocation, if it still holds one.
   *
   * Idempotent by design: `false` means exactly one thing — a running match still
   * owns this account's seat, so the caller must keep the ticket. Everything else
   * (`true`) means the account now holds no live reservation, including a room id
   * that was never initialized, a seat the room no longer knows, a private room
   * with no matchmaking allocation, an already-terminated reservation and one
   * whose deadline passed. Callers must be the trusted matchmaker.
   */
  async cancelReservation(userId: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return true;
    const seated = store.getPlayer(sql, userId) !== null;
    if (MATCH_ACTIVE[room.phase] && seated) return false;
    if (room.mode !== 'quick' || room.reservation_state !== 'reserved') return true;
    if (!seated) return true;
    const live = this.reservationIsLive(room, Date.now());
    this.endReservation(live ? 'cancelled' : 'expired', live ? '匹配已取消，请重新匹配。' : '匹配超时，请重新匹配。');
    await this.scheduleAlarm();
    return true;
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
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    const doomed: { ws: WebSocket; meta: SocketAuth }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const meta = readSocketMeta(ws);
      if (meta && meta.sessionHash === sessionHash) doomed.push({ ws, meta });
    }
    if (doomed.length === 0) return;
    // Authority first, synchronously: every matching attachment — including one
    // that is already closing, whose queued frames are still authorized by the
    // seat's conn_id — loses it before any await or close.
    for (const { meta } of doomed) this.unbindSocket(sql, meta);
    let closeFailure: unknown = null;
    for (const { ws } of doomed) {
      if (ws.readyState !== WS_OPEN) continue;
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
    this.reconcileHost(sql);
    this.pushSnapshots();
    // The auth layer answers the logout only once every room confirms, so a
    // socket that is still open must fail this call instead of passing silently.
    if (closeFailure !== null || doomed.some(({ ws }) => ws.readyState === WS_OPEN)) {
      console.error(
        '[room] revocation incomplete',
        room?.id ?? '',
        closeFailure instanceof Error ? closeFailure.name : typeof closeFailure,
      );
      throw new Error('room:revoke_incomplete');
    }
    await this.scheduleAlarm();
  }

  /**
   * A quick reservation is live only until its deadline: the clock decides, so a
   * delayed alarm can never let a late player join or start on a dead ticket.
   */
  private reservationIsLive(room: RoomRow, now: number): boolean {
    return room.reservation_state === 'reserved' && room.reservation_expires_at !== null && room.reservation_expires_at > now;
  }

  private reservationIsGone(room: RoomRow, now: number): boolean {
    if (room.mode !== 'quick') return false;
    if (room.reservation_state === 'cancelled' || room.reservation_state === 'expired') return true;
    return room.reservation_state === 'reserved' && !this.reservationIsLive(room, now);
  }

  // ------------------------------------------------------------ WebSocket

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade') ?? '';
    if (upgrade.toLowerCase() !== 'websocket') return jsonError(400, '需要 WebSocket 升级请求。');

    let auth: SocketAuth;
    try {
      auth = readSocketAuth(request);
    } catch (error) {
      return rejectionResponse(error);
    }

    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return jsonError(404, new RoomRejection('room:not_found', '房间不存在或已结束。').userMessage);
    const claimedRoomId = request.headers.get('x-room-id');
    if (claimedRoomId !== null && claimedRoomId !== room.id) return jsonError(404, '房间不存在或已结束。');
    if (this.reservationIsGone(room, Date.now())) {
      return jsonError(409, new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。').userMessage);
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
        if (!(await registerSessionRoom(this.env, auth.sessionHash, room.id))) {
          return { status: 403, message: '登录状态已失效，请重新登录。' };
        }
        if (!store.getPlayer(sql, auth.userId)) {
          if (room.mode === 'quick') return { status: 409, message: '匹配已结束，请重新匹配。' };
          if (room.locked !== 0 || room.phase !== 'lobby') return { status: 409, message: '比赛已开始，无法加入。' };
          const seated = store.insertPlayer(sql, {
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
          if (meta && meta.userId === auth.userId) this.closeSocket(other, WS_CLOSE.replaced, 'replaced by a newer connection');
        }
        // The seat's live connection is bound inside the same section that
        // registered and accepted it, so a revocation sweep can never see an open
        // socket that the seat does not yet point at.
        store.updatePlayer(sql, auth.userId, { conn_id: auth.connId, slot_expires_at: null, seated: 1 });
        this.reconcileHost(sql);
        this.maybeAutoStart(store.getRoom(sql) ?? room);
        return null;
      } catch (error) {
        // A storage or provider hiccup must cost one handshake, not the room.
        console.error('[room] handshake failed', room.id, error instanceof Error ? error.name : typeof error);
        return { status: 500, message: '服务器内部错误' };
      }
    });
    if (refusal !== null) return jsonError(refusal.status, refusal.message);

    this.pushSnapshots();
    await this.scheduleAlarm();

    return new Response(null, { status: 101, webSocket: client });
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
    if (typeof message !== 'string') {
      this.sendTo(ws, { type: 'error', message: '不支持的消息格式。' });
      return;
    }
    if (message.length > MAX_MESSAGE_BYTES || (message.length > MESSAGE_LENGTH_FAST_PATH && byteLength(message) > MAX_MESSAGE_BYTES)) {
      this.sendTo(ws, { type: 'error', message: '消息过大。' });
      return;
    }
    if (meta.sessionExpires <= Date.now()) {
      this.sendTo(ws, { type: 'error', message: '登录状态已过期，请重新登录。' });
      this.closeSocket(ws, WS_CLOSE.sessionExpired, 'session expired');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.sendTo(ws, { type: 'error', message: '消息格式错误。' });
      return;
    }
    const clientMessage = parseClientMessage(parsed);
    if (!clientMessage) {
      this.sendTo(ws, { type: 'error', message: '消息格式错误。' });
      return;
    }

    try {
      await this.handleMessage(ws, meta, clientMessage);
    } catch (error) {
      console.error('[room] message handling failed', clientMessage.type, error instanceof Error ? error.message : typeof error);
      this.sendTo(ws, { type: 'error', message: '服务器处理失败，请重试。' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.handleSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[room] socket error', error instanceof Error ? error.name : typeof error);
    await this.handleSocketGone(ws);
  }

  private async handleSocketGone(ws: WebSocket): Promise<void> {
    const meta = readSocketMeta(ws);
    if (!meta) return;
    const sql = this.ctx.storage.sql;
    const released = this.unbindSocket(sql, meta);
    // Dropping this room's reference to the session is checked and written inside
    // the same critical section that accepts connections, so a connection that
    // re-registers this session cannot slip its insert in front of this delete and
    // have its reference erased. It runs on every close branch — including a
    // superseded socket, whose replacement still needs the reference — and only
    // when no socket here still holds that session open, so a revocation this room
    // has not confirmed keeps its retry target. The helper never throws: a close
    // path must not be able to reject a critical section.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.dropSessionRef(meta.sessionHash, ws);
    });
    if (!released) return;
    this.reconcileHost(sql);
    this.pushSnapshots();
    await this.scheduleAlarm();
  }

  /**
   * Removes this room's session reference once no socket here still holds that
   * session open. Called only from inside the room's critical section, and it
   * never throws: a reference left behind only costs one no-op revocation later,
   * while an exception escaping a critical section would take the room with it.
   */
  private async dropSessionRef(sessionHash: string, closing: WebSocket): Promise<void> {
    try {
      for (const ws of this.ctx.getWebSockets()) {
        if (ws === closing || ws.readyState !== WS_OPEN) continue;
        const meta = readSocketMeta(ws);
        if (meta && meta.sessionHash === sessionHash) return;
      }
      const room = store.getRoom(this.ctx.storage.sql);
      if (!room) return;
      await unregisterSessionRoom(this.env, sessionHash, room.id);
    } catch (error) {
      console.error('[room] session reference cleanup failed', error instanceof Error ? error.name : typeof error);
    }
  }

  /**
   * Releases one socket's hold on its seat.
   *
   * `conn_id` is the seat's authority, so there is exactly one rule for a close,
   * a replacement and a revocation: the seat is cleared only when this socket is
   * the one it points at. That makes a superseded or revoked connection stop
   * counting as the player's socket immediately, independent of whether its
   * physical close ever lands. The input window is dropped unconditionally so a
   * frame already queued for this connection cannot act.
   */
  private unbindSocket(sql: SqlStorage, meta: SocketAuth): boolean {
    this.inputWindows.delete(meta.connId);
    const room = store.getRoom(sql);
    const player = store.getPlayer(sql, meta.userId);
    if (!room || !player || player.conn_id !== meta.connId) return false;
    const keepSeatAlive = room.locked !== 0 || room.phase !== 'lobby';
    store.updatePlayer(sql, meta.userId, {
      conn_id: null,
      slot_expires_at: keepSeatAlive ? null : Date.now() + SEAT_TTL_MS,
    });
    return true;
  }

  /**
   * Connection ids that are both recorded on a seat and backed by an open socket.
   * Everything that delivers state, decides who is online or hands over the host
   * resolves through this one set.
   */
  private currentConns(players: readonly PlayerRow[]): Set<string> {
    const recorded = new Set<string>();
    for (const row of players) {
      if (row.conn_id !== null) recorded.add(row.conn_id);
    }
    const conns = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      const meta = readSocketMeta(ws);
      if (meta && recorded.has(meta.connId)) conns.add(meta.connId);
    }
    return conns;
  }

  // ------------------------------------------------------------- Messages

  private async handleMessage(ws: WebSocket, meta: SocketAuth, clientMessage: ClientMessage): Promise<void> {
    // A socket we have already decided to close — replaced, leaving, revoked or
    // expired by the session sweep — can still deliver frames that were queued
    // before that close. The close is the authority boundary, so a frame from a
    // non-open socket mutates nothing; the `conn_id` check below catches the rest.
    if (ws.readyState !== WS_OPEN) return;
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) {
      this.sendTo(ws, { type: 'error', message: '房间不存在或已结束。' });
      this.closeSocket(ws, WS_CLOSE.closed, 'room gone');
      return;
    }
    const player = store.getPlayer(sql, meta.userId);
    if (!player) {
      this.sendTo(ws, { type: 'error', message: '你不在这个房间中。' });
      this.closeSocket(ws, WS_CLOSE.closed, 'not seated');
      return;
    }
    // A connection that a newer one replaced may not act any more.
    if (player.conn_id !== meta.connId) {
      this.sendTo(ws, { type: 'error', message: '连接已被新的登录替换。' });
      this.closeSocket(ws, WS_CLOSE.replaced, 'superseded');
      return;
    }
    if (clientMessage.type === 'ping') {
      this.sendTo(ws, { type: 'pong', serverNow: Date.now() });
      return;
    }

    switch (clientMessage.type) {
      case 'ready': {
        if (room.phase !== 'lobby') {
          this.sendTo(ws, { type: 'error', message: '比赛已开始，无法变更准备状态。' });
          return;
        }
        store.updatePlayer(sql, meta.userId, { ready: clientMessage.ready ? 1 : 0 });
        this.pushSnapshots();
        return;
      }
      case 'start': {
        if (room.phase === 'generating') {
          this.sendTo(ws, { type: 'error', message: '正在出题，请稍候。' });
          return;
        }
        if (room.phase !== 'lobby') {
          this.sendTo(ws, { type: 'error', message: '比赛已经开始。' });
          return;
        }
        if (room.mode === 'quick' && room.reservation_state === 'reserved') {
          this.sendTo(ws, { type: 'error', message: '快速对战在双方到齐后自动开始。' });
          return;
        }
        if (room.host_id !== meta.userId) {
          this.sendTo(ws, { type: 'error', message: '只有房主可以开始比赛。' });
          return;
        }
        const roster = store.listPlayers(sql);
        const online = onlineUserIds(roster, this.currentConns(roster));
        // Reserved invitees that never connected are released at lock time; a
        // player who actually joined is never dropped silently.
        const missing = roster.filter((row) => row.seated === 1 && !online.has(row.user_id));
        if (missing.length > 0) {
          this.sendTo(ws, { type: 'error', message: `还有玩家未连接：${missing.map((row) => row.username).join('、')}。` });
          return;
        }
        if (online.size < MIN_PLAYERS) {
          this.sendTo(ws, { type: 'error', message: '至少需要 2 名已连接玩家才能开始。' });
          return;
        }
        const others = roster.filter((row) => row.user_id !== meta.userId && row.seated === 1);
        if (others.some((row) => row.ready !== 1)) {
          this.sendTo(ws, { type: 'error', message: '还有玩家尚未准备。' });
          return;
        }
        if (!this.startMatch(sql, room)) {
          // startMatch records why the lobby stays open; the snapshot carries it.
          this.pushSnapshots();
          await this.scheduleAlarm();
          return;
        }
        this.pushSnapshots();
        await this.scheduleAlarm();
        return;
      }
      case 'input': {
        await this.handleInput(ws, meta, clientMessage);
        return;
      }
      case 'rematch': {
        if (room.phase !== 'finished') {
          this.sendTo(ws, { type: 'error', message: '比赛尚未结束。' });
          return;
        }
        store.resetPlayersForMatch(sql);
        store.clearReady(sql);
        store.updateRoom(sql, {
          phase: 'lobby',
          deadline: 0,
          started_at: null,
          ended_at: null,
          end_reason: null,
          match_id: null,
          spell_book: null,
          events_json: '[]',
          event_seq: 0,
          error: null,
          locked: 0,
          generation_token: null,
          generation_claim: null,
        });
        // Seats that were held through the match expire again, so an absent
        // player cannot block the next start; the connected ones keep theirs.
        const roster = store.listPlayers(sql);
        store.armLobbySeatExpiry(sql, [...onlineUserIds(roster, this.currentConns(roster))], Date.now() + SEAT_TTL_MS);
        this.reconcileHost(sql);
        this.pushSnapshots();
        await this.scheduleAlarm();
        return;
      }
      case 'leave': {
        if (room.mode === 'quick' && room.reservation_state === 'reserved' && room.phase === 'lobby' && room.locked === 0) {
          this.endReservation('cancelled', '对手已离开，请重新匹配。');
          await this.scheduleAlarm();
          return;
        }
        if (room.phase === 'lobby' && room.locked === 0) {
          store.deletePlayer(sql, meta.userId);
          this.reconcileHost(sql);
          this.pushSnapshots();
          this.closeSocket(ws, WS_CLOSE.closed, 'left');
          await this.scheduleAlarm();
          return;
        }
        // Locked roster: the seat is kept so a refresh or reconnect resumes the
        // same place, and the rest of the match keeps running.
        this.closeSocket(ws, WS_CLOSE.closed, 'left');
        return;
      }
      default:
        return;
    }
  }

  /**
   * One authoritative typing step.
   *
   * The only accepted packet is the one carrying the player's *current* spell
   * index and the current match id, so a repeated or stale completion — from a
   * resent WebSocket frame, a reconnect replay or a duplicate tab — is dropped
   * whole and can never deal damage twice. A completion applies its damage, any
   * elimination and the attacker's own advancement in one synchronous block:
   * there is no await between them, so no observer can see a half-applied hit.
   */
  private async handleInput(ws: WebSocket, meta: SocketAuth, message: { matchId: string; spellIndex: number; text: string }): Promise<void> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return;
    const players = store.listPlayers(sql);
    const self = players.find((row) => row.user_id === meta.userId);
    if (!self) return;

    if (room.phase !== 'playing' || room.match_id === null) {
      this.sendSnapshotTo(ws, meta);
      return;
    }
    if (message.matchId !== room.match_id) {
      this.sendTo(ws, { type: 'error', message: '比赛状态已更新，请以最新法术为准。' });
      this.sendSnapshotTo(ws, meta);
      return;
    }
    const now = Date.now();
    // The deadline ends the match for everyone: no input is accepted past it.
    if (room.deadline > 0 && now >= room.deadline) {
      await this.finishMatch('timeout', room.deadline);
      return;
    }
    if (self.eliminated_at !== null) {
      this.sendSnapshotTo(ws, meta);
      return;
    }
    // Replay guard: a stale packet would carry an older spell index.
    if (message.spellIndex !== self.spell_index) {
      this.sendSnapshotTo(ws, meta);
      return;
    }
    if (charCount(message.text) > MAX_INPUT_CHARS) {
      this.sendTo(ws, { type: 'error', message: '输入内容过长。' });
      return;
    }
    const book = bookOf(room);
    const spell = spellAt(book, self.spell_index);
    if (!spell) return;
    if (!this.allowInput(meta.connId)) return;

    const delta = diffSnapshot(self.last_input, message.text, spell.text);
    const attemptTotal = self.attempt_total + delta.inserted;
    const errorTotal = self.error_total + delta.errors;

    if (message.text !== spell.text) {
      // Partial draft: accepted as the player's snapshot, and its keystrokes are
      // aggregated so accuracy spans the whole match, not one spell.
      store.updatePlayer(sql, self.user_id, {
        progress: delta.progress,
        last_input: message.text,
        attempt_total: attemptTotal,
        error_total: errorTotal,
      });
      this.pushSnapshots();
      return;
    }

    const target = nextAliveBySeat(players, self.slot, (seat) => seat.eliminated_at === null);
    if (!target) {
      // No other seat to damage: the match is already decided.
      await this.finishMatch('elimination', now);
      return;
    }
    const damage = Math.min(damageOf(spell.text), target.hp);
    const targetHp = Math.max(0, target.hp - damage);
    const eliminated = targetHp === 0;
    const seq = room.event_seq + 1;

    store.updatePlayer(sql, target.user_id, eliminated ? { hp: targetHp, eliminated_at: now } : { hp: targetHp });
    store.updatePlayer(sql, self.user_id, {
      progress: 0,
      last_input: '',
      spell_index: self.spell_index + 1,
      spells_cast: self.spells_cast + 1,
      correct_chars: self.correct_chars + charCount(spell.text),
      // The damage actually dealt — already clamped to the target's remaining
      // health — is what this player is credited with, and it accumulates across
      // spells because every other counter is read from the same live row.
      damage_dealt: self.damage_dealt + damage,
      attempt_total: attemptTotal,
      error_total: errorTotal,
    });
    // The event never carries the completed spell's text: opponents learn how
    // much was dealt, not what was typed.
    const event: CombatEvent = {
      seq,
      at: now,
      attackerId: self.user_id,
      targetId: target.user_id,
      element: spell.element,
      damage,
      targetHp,
      spellIndex: self.spell_index,
      eliminated,
    };
    store.appendEvent(sql, event);

    const remainingAlive = players.filter((row) => (row.user_id === target.user_id ? !eliminated : row.eliminated_at === null)).length;
    if (remainingAlive <= 1) {
      // Last opponent down: the match ends now instead of waiting out the clock.
      await this.finishMatch('elimination', now);
      return;
    }
    this.pushSnapshots();
  }

  private allowInput(connId: string): boolean {
    const now = Date.now();
    const window = this.inputWindows.get(connId);
    if (!window || now - window.startedAt >= 1_000) {
      this.inputWindows.set(connId, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= INPUTS_PER_SECOND) return false;
    window.count++;
    return true;
  }

  // ---------------------------------------------------------------- Alarms

  async alarm(): Promise<void> {
    for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
      const progressed = await this.advanceOnce();
      if (!progressed) break;
    }
    await this.scheduleAlarm();
  }

  /**
   * Performs at most one due transition (or one pending generation / save
   * retry). Deadlines come from persisted state, so a late alarm catches up
   * without extending or reopening anything and without double scoring.
   */
  private async advanceOnce(): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return false;
    const now = Date.now();

    // An expired or revoked session loses its connection (and its seat) even
    // while the room is otherwise idle.
    const expired = this.expiredSockets(now);
    if (expired.length > 0) {
      for (const { ws, meta } of expired) {
        this.sendTo(ws, { type: 'error', message: '登录状态已过期，请重新登录。' });
        this.closeSocket(ws, WS_CLOSE.sessionExpired, 'session expired');
        this.unbindSocket(sql, meta);
      }
      this.reconcileHost(sql);
      this.pushSnapshots();
      return true;
    }

    if (room.phase === 'generating' && room.generation_token !== null) {
      if (room.generation_claim === room.generation_token) {
        // A previous attempt was interrupted before it could settle. Re-calling
        // the provider would silently re-bill; fail honestly instead.
        this.abortMatch(sql, '出题中断，请重试。');
        return true;
      }
      store.updateRoom(sql, { generation_claim: room.generation_token });
      await this.runGeneration(room);
      return true;
    }

    if (TIMED_PHASES[room.phase] && room.deadline > 0 && now >= room.deadline) {
      if (room.phase === 'countdown') {
        // The combat clock is derived from the countdown deadline, so a late
        // alarm shifts the whole match rather than handing out extra time.
        store.updateRoom(sql, { phase: 'playing', started_at: room.deadline, deadline: room.deadline + MATCH_DURATION_MS });
        this.pushSnapshots();
        return true;
      }
      if (room.phase === 'playing') {
        await this.finishMatch('timeout', room.deadline);
        return true;
      }
    }

    if (room.mode === 'quick' && room.reservation_state === 'reserved' && room.reservation_expires_at !== null && now >= room.reservation_expires_at) {
      this.endReservation('expired', '匹配超时，请重新匹配。');
      return true;
    }

    if (room.locked === 0 && room.phase === 'lobby') {
      const removed = store.expireSeats(sql, now);
      if (removed > 0) {
        this.reconcileHost(sql);
        this.pushSnapshots();
        return true;
      }
    }

    // The queued rows are the durable truth: whenever any are unsaved and no
    // lease/backoff is running, a write is due — including the `saving` state a
    // reset left behind mid-batch.
    if (store.countUnsavedResults(sql) > 0 && (room.persist_retry_at === null || now >= room.persist_retry_at)) {
      await this.saveResults();
      this.pushSnapshots();
      return true;
    }

    return false;
  }

  private async scheduleAlarm(): Promise<void> {
    const room = store.getRoom(this.ctx.storage.sql);
    if (!room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const timers: number[] = [];
    if (room.phase === 'generating' && room.generation_token !== null) timers.push(Date.now());
    if (TIMED_PHASES[room.phase] && room.deadline > 0) timers.push(room.deadline);
    if (room.reservation_state === 'reserved' && room.reservation_expires_at !== null) timers.push(room.reservation_expires_at);
    // Unsaved result rows always keep a timer: a scheduled lease/backoff when
    // there is one, an immediate attempt otherwise.
    if (store.countUnsavedResults(this.ctx.storage.sql) > 0) timers.push(room.persist_retry_at ?? Date.now());
    let earliestSessionExpiry = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      const meta = readSocketMeta(ws);
      if (meta && meta.sessionExpires < earliestSessionExpiry) earliestSessionExpiry = meta.sessionExpires;
    }
    if (Number.isFinite(earliestSessionExpiry)) timers.push(earliestSessionExpiry);
    if (room.locked === 0 && room.phase === 'lobby') {
      const seats = store
        .listPlayers(this.ctx.storage.sql)
        .map((row) => row.slot_expires_at)
        .filter((value): value is number => value !== null);
      if (seats.length > 0) timers.push(Math.min(...seats));
    }
    if (timers.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...timers)));
  }

  // --------------------------------------------------------------- Matching

  private startMatch(sql: SqlStorage, room: RoomRow): boolean {
    store.deleteReservedSeats(sql);
    if (store.countPlayers(sql) < MIN_PLAYERS) {
      store.updateRoom(sql, { error: '至少需要 2 名已连接玩家才能开始。' });
      return false;
    }
    store.resetPlayersForMatch(sql);
    const generationSeq = room.generation_seq + 1;
    const matchId = crypto.randomUUID();
    store.updateRoom(sql, {
      phase: 'generating',
      deadline: 0,
      started_at: null,
      ended_at: null,
      end_reason: null,
      match_id: matchId,
      spell_book: null,
      events_json: '[]',
      event_seq: 0,
      error: null,
      locked: 1,
      generation_seq: generationSeq,
      generation_token: `${matchId}:${generationSeq}`,
      generation_claim: null,
      reservation_state: 'locked',
      reservation_expires_at: null,
    });
    return true;
  }

  private maybeAutoStart(room: RoomRow): boolean {
    const sql = this.ctx.storage.sql;
    if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return false;
    if (!this.reservationIsLive(room, Date.now())) return false;
    const players = store.listPlayers(sql);
    if (players.length !== 2) return false;
    const online = onlineUserIds(players, this.currentConns(players));
    if (!players.every((row) => online.has(row.user_id))) return false;
    return this.startMatch(sql, room);
  }

  private async runGeneration(room: RoomRow): Promise<void> {
    const token = room.generation_token;
    if (token === null) return;
    const outcome = await generateSpellSet(this.env, {
      theme: room.theme,
      difficulty: room.difficulty,
      variation: `${room.match_id ?? ''}:${room.generation_seq}`,
    });

    const sql = this.ctx.storage.sql;
    const fresh = store.getRoom(sql);
    // Stale-result guard: a response from a superseded match or attempt can
    // never overwrite newer state, and it never triggers another paid call.
    if (!fresh || fresh.phase !== 'generating' || fresh.generation_token !== token) return;

    if (!outcome.ok) {
      console.error('[room] generation failed', fresh.id, outcome.reason);
      this.abortMatch(sql, outcome.message);
      return;
    }

    // One shared book, one opening countdown: the combat deadline is derived
    // from the end of this countdown so it is fixed the moment combat starts.
    const countdownEnd = Date.now() + OPENING_COUNTDOWN_MS;
    store.updateRoom(sql, {
      spell_book: JSON.stringify(outcome.spells),
      phase: 'countdown',
      started_at: null,
      deadline: countdownEnd,
      error: null,
      generation_token: null,
      generation_claim: null,
    });
    this.pushSnapshots();
  }

  /** Returns the room to an open lobby after a match never came together. */
  private abortMatch(sql: SqlStorage, message: string): void {
    store.updateRoom(sql, {
      phase: 'lobby',
      deadline: 0,
      started_at: null,
      ended_at: null,
      end_reason: null,
      match_id: null,
      spell_book: null,
      events_json: '[]',
      event_seq: 0,
      locked: 0,
      error: message,
      generation_token: null,
      generation_claim: null,
      reservation_state: 'none',
      reservation_expires_at: null,
    });
    const roster = store.listPlayers(sql);
    store.armLobbySeatExpiry(sql, [...onlineUserIds(roster, this.currentConns(roster))], Date.now() + SEAT_TTL_MS);
    this.reconcileHost(sql);
    this.pushSnapshots();
  }

  // ---------------------------------------------------------------- Scoring

  /**
   * Settles the match exactly once and queues its history rows.
   *
   * `endedAt` is authoritative rather than the (possibly late) alarm: either the
   * instant the last opponent fell or the match deadline. A settled match never
   * accepts input again, and every player's speed is frozen at their own finish
   * — the winner of the clock is not the only player whose time stops.
   */
  private async finishMatch(reason: EndReason, endedAt: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room || room.phase !== 'playing' || room.match_id === null) return;
    const matchId = room.match_id;
    const players = store.listPlayers(sql);
    const startedAt = room.started_at ?? endedAt;
    const durationMs = Math.max(0, endedAt - startedAt);

    const speed = new Map<string, number>();
    for (const row of players) {
      const activeEnd = row.eliminated_at !== null ? Math.min(row.eliminated_at, endedAt) : endedAt;
      const cpm = cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000));
      speed.set(row.user_id, cpm);
      store.updatePlayer(sql, row.user_id, { cpm });
    }

    const ranks = survivalRanks(
      players.map((row) => ({
        userId: row.user_id,
        hp: row.hp,
        damageDealt: row.damage_dealt,
        correctChars: row.correct_chars,
        eliminatedAt: row.eliminated_at,
      })),
    );
    const rows: Omit<ResultRow, 'saved'>[] = players.map((row) => ({
      match_id: matchId,
      user_id: row.user_id,
      theme: room.theme,
      damage_dealt: row.damage_dealt,
      hp_remaining: row.hp,
      spells_cast: row.spells_cast,
      correct_chars: row.correct_chars,
      duration_ms: durationMs,
      rank: ranks.get(row.user_id) ?? players.length,
      cpm: speed.get(row.user_id) ?? 0,
      accuracy: accuracyOf(row.attempt_total, row.error_total),
      created_at: Date.now(),
    }));
    store.queueResults(sql, rows);

    // The allocation is consumed by the finished match: a queue ticket can be
    // dropped instead of waiting on a room that will never be playable again.
    store.updateRoom(sql, {
      phase: 'finished',
      deadline: 0,
      ended_at: endedAt,
      end_reason: reason,
      reservation_state: 'none',
      reservation_expires_at: null,
      persistence: 'saving',
      persist_retry_at: null,
      persist_attempts: 0,
    });
    // The rows are durable before the first external call: arm the recovery
    // timer first so a reset mid-write can never strand them.
    await this.scheduleAlarm();
    this.pushSnapshots();
    await this.saveResults();
    this.pushSnapshots();
  }

  /**
   * Writes every queued result row with an idempotent upsert (`ON CONFLICT DO
   * NOTHING`, not `INSERT OR IGNORE`: a genuinely malformed row must raise and
   * stay in the retry path instead of being silently dropped), then derives the
   * visible state from what is actually still unsaved. A slower, older batch can
   * therefore never report "saved" for rows a newer batch queued, and a retried
   * write can never count a match twice.
   */
  private async saveResults(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return;
    const pending = store.listUnsavedResults(sql);
    if (pending.length === 0) {
      if (room.persistence !== 'saved') store.updateRoom(sql, { persistence: 'saved', persist_retry_at: null, persist_attempts: 0 });
      return;
    }
    // Lease the attempt durably and arm the alarm *before* the external write:
    // a reset between here and the D1 reply is recovered from the queued rows,
    // and the lease keeps a concurrent attempt from starting meanwhile.
    store.updateRoom(sql, { persistence: 'saving', persist_retry_at: Date.now() + PERSIST_LEASE_MS });
    await this.scheduleAlarm();
    let failure: unknown = null;
    try {
      await this.env.DB.batch(
        pending.map((row) =>
          this.env.DB.prepare(
            `INSERT INTO results (
              match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms,
              rank, cpm, accuracy, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(match_id, user_id) DO NOTHING`,
          ).bind(
            row.match_id,
            row.user_id,
            row.theme,
            row.damage_dealt,
            row.hp_remaining,
            row.spells_cast,
            row.correct_chars,
            row.duration_ms,
            row.rank,
            row.cpm,
            row.accuracy,
            row.created_at,
          ),
        ),
      );
      store.markResultsSaved(sql, pending);
    } catch (error) {
      failure = error;
    }
    if (store.countUnsavedResults(sql) === 0) {
      store.updateRoom(sql, { persistence: 'saved', persist_retry_at: null, persist_attempts: 0 });
    } else {
      // Retries are unbounded with a capped delay: a result that is merely late
      // is recoverable, and the visible state stays `error` until it lands.
      const attempts = room.persist_attempts + 1;
      const retryAt = Date.now() + Math.min(PERSIST_BACKOFF_CAP_MS, 2_000 * 2 ** Math.min(attempts, 5));
      store.updateRoom(sql, { persistence: 'error', persist_attempts: attempts, persist_retry_at: retryAt });
      console.error('[room] result save failed', room.id, attempts, failure instanceof Error ? failure.name : typeof failure);
    }
    // Replace the attempt lease with whatever the outcome actually needs.
    await this.scheduleAlarm();
  }

  /** Ends a live quick reservation: both seats freed, every socket told and closed. */
  private endReservation(state: 'cancelled' | 'expired', message: string): void {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return;
    if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return;
    store.updateRoom(sql, { reservation_state: state, reservation_expires_at: null, error: message });
    this.pushSnapshots();
    store.deleteAllPlayers(sql);
    for (const ws of this.ctx.getWebSockets()) this.closeSocket(ws, WS_CLOSE.closed, state);
  }

  // ------------------------------------------------------------ Connectivity

  private expiredSockets(now: number): { ws: WebSocket; meta: SocketAuth }[] {
    const expired: { ws: WebSocket; meta: SocketAuth }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      const meta = readSocketMeta(ws);
      if (meta && meta.sessionExpires <= now) expired.push({ ws, meta });
    }
    return expired;
  }

  /**
   * Hands the room to the lowest-seated connected player whenever the host is
   * not a connected seat. A host who left the room is no longer in the roster
   * even while its socket is still open, so leaving in the lobby always hands
   * control over instead of stranding the remaining players. A host whose
   * connection was revoked counts as gone even if its close has not landed.
   */
  private reconcileHost(sql: SqlStorage): void {
    const room = store.getRoom(sql);
    if (!room) return;
    const roster = store.listPlayers(sql);
    const online = onlineUserIds(roster, this.currentConns(roster));
    if (roster.some((row) => row.user_id === room.host_id) && online.has(room.host_id)) return;
    const candidate = roster.find((row) => online.has(row.user_id));
    if (!candidate) return;
    store.updateRoom(sql, { host_id: candidate.user_id });
  }

  // -------------------------------------------------------------- Snapshots

  private snapshotContext(sql: SqlStorage, room: RoomRow): SnapshotContext {
    const players = store.listPlayers(sql);
    const ranks =
      room.phase === 'finished' && room.match_id !== null
        ? survivalRanks(
            players.map((row) => ({
              userId: row.user_id,
              hp: row.hp,
              damageDealt: row.damage_dealt,
              correctChars: row.correct_chars,
              eliminatedAt: row.eliminated_at,
            })),
          )
        : null;
    return {
      room,
      players,
      // The book is public the moment generation succeeds; an unreadable or
      // absent one simply leaves every player without a spell.
      book: BOOK_PHASES[room.phase] ? bookOf(room) : [],
      events: room.match_id !== null ? store.readEvents(room) : [],
      conns: this.currentConns(players),
      ranks,
      serverNow: Date.now(),
    };
  }

  /**
   * Correct confirmed characters per active minute at this instant: completed
   * characters plus the current accepted prefix, over combat time only. The
   * clock stops at the viewer's own elimination, so a corpse's speed is frozen.
   */
  private cpmFor(row: PlayerRow, room: RoomRow, now: number): number {
    const startedAt = room.started_at;
    if (startedAt === null) return 0;
    const activeEnd = row.eliminated_at ?? room.ended_at ?? now;
    return cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000));
  }

  private buildSnapshot(context: SnapshotContext, viewerId: string): RoomSnapshot {
    const room = context.room;
    // Only the viewer's own spell ever leaves the room: rivals' texts are never sent.
    const book = context.book;
    const players: Player[] = context.players.map((row) => {
      const spell = spellAt(book, row.spell_index);
      return {
        id: row.user_id,
        username: row.username,
        slot: row.slot,
        connected: row.conn_id !== null && context.conns.has(row.conn_id),
        ready: row.ready === 1,
        progress: row.progress,
        spellLength: spell ? charCount(spell.text) : 0,
        spellIndex: row.spell_index,
        spellsCast: row.spells_cast,
        hp: row.hp,
        maxHp: row.max_hp,
        damageDealt: row.damage_dealt,
        correctChars: row.correct_chars,
        eliminatedAt: row.eliminated_at,
        cpm: this.cpmFor(row, room, context.serverNow),
        accuracy: accuracyOf(row.attempt_total, row.error_total),
        rank: context.ranks?.get(row.user_id) ?? null,
      };
    });
    const viewer = context.players.find((row) => row.user_id === viewerId) ?? null;
    // An eliminated player has no spell to type and no live draft to replay.
    const spell = viewer !== null && viewer.eliminated_at === null ? spellAt(book, viewer.spell_index) : null;
    const typing = viewer !== null && room.phase === 'playing' && viewer.eliminated_at === null;
    return {
      id: room.id,
      matchId: room.match_id,
      hostId: room.host_id,
      mode: room.mode,
      theme: room.theme,
      difficulty: room.difficulty,
      phase: room.phase,
      deadline: TIMED_PHASES[room.phase] ? room.deadline : 0,
      serverNow: context.serverNow,
      startedAt: room.started_at,
      endedAt: room.ended_at,
      endReason: room.end_reason,
      spell,
      selfInput: typing && viewer !== null ? viewer.last_input : '',
      events: context.events,
      persistence: room.persistence,
      reservationExpiresAt: room.reservation_state === 'reserved' ? room.reservation_expires_at : null,
      players,
      error: room.error,
    };
  }

  /**
   * Sends every seat its own snapshot. Delivery follows the same authority rule
   * as everything else: only a connection the seat currently points at may
   * receive that seat's state, so a revoked or replaced socket stops being a
   * delivery target even if its physical close has not landed — it is told and
   * closed instead, and the room never depends on a close succeeding.
   */
  private pushSnapshots(): void {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return;
    const context = this.snapshotContext(sql, room);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      const meta = readSocketMeta(ws);
      if (!meta) continue;
      if (!context.conns.has(meta.connId)) {
        this.closeSocket(ws, WS_CLOSE.replaced, 'not the current connection');
        continue;
      }
      this.sendTo(ws, { type: 'state', room: this.buildSnapshot(context, meta.userId) });
    }
  }

  /** Answers one socket with its own snapshot; a connection the seat no longer points at gets nothing. */
  private sendSnapshotTo(ws: WebSocket, meta: SocketAuth): void {
    const sql = this.ctx.storage.sql;
    const room = store.getRoom(sql);
    if (!room) return;
    const context = this.snapshotContext(sql, room);
    if (!context.conns.has(meta.connId)) return;
    this.sendTo(ws, { type: 'state', room: this.buildSnapshot(context, meta.userId) });
  }

  private sendTo(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[room] send failed', error instanceof Error ? error.name : typeof error);
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch (error) {
      console.error('[room] close failed', error instanceof Error ? error.name : typeof error);
    }
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
