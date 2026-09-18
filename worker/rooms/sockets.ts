import { WS_CLOSE, WS_PROTOCOL } from '../../shared/protocol';
import type { ServerMessage } from '../../shared/protocol';
import { unregisterSessionRoom } from '../auth/sessions';
import { RoomRejection } from './rejection';
import { SEAT_TTL_MS } from './rules';
import type { RoomScope } from './scope';
import { getPlayer, listPlayers, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import type { PlayerRow } from './storage/schema';

/** The accounts a socket speaks for, fixed at handshake time from headers the Worker wrote. */
export type SocketAuth = {
  userId: string;
  username: string;
  connId: string;
  sessionHash: string;
  sessionExpires: number;
  /**
   * Wire protocol this attachment was accepted under. New handshakes always carry
   * `WS_PROTOCOL`; the field may be absent only on an attachment persisted by an older build.
   * Such an attachment is recognized and cut off — it is never a working legacy dialect.
   */
  protocolVersion?: string;
};

/** Reads the trusted handshake headers; a missing, malformed or expired session is a refusal, never a socket. */
export function readSocketAuth(request: Request): SocketAuth {
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
  return {
    userId,
    username: username || userId,
    connId: crypto.randomUUID(),
    sessionHash,
    sessionExpires,
    protocolVersion: WS_PROTOCOL,
  };
}

/** The refresh message every non-v2 handshake and stale attachment is told exactly once. */
export const PROTOCOL_REFRESH_MESSAGE = '客户端版本已更新，请刷新页面后继续。';

/** True when an attachment speaks exactly the wire protocol this build serves. */
export function currentProtocolSocket(meta: SocketAuth): boolean {
  return meta.protocolVersion === WS_PROTOCOL;
}

/**
 * Strips one stale-protocol attachment of its authority, tells it to refresh and closes it with
 * the protocol-mismatch code. The caller finishes with the usual reconcile/snapshot/alarm trio —
 * once per sweep, not per socket — because the early unbind makes the close callback skip them.
 */
export function rejectStaleSocket(scope: RoomScope, ws: WebSocket, meta: SocketAuth): void {
  unbindSocket(scope, meta);
  sendTo(ws, { type: 'error', message: PROTOCOL_REFRESH_MESSAGE });
  closeSocket(ws, WS_CLOSE.protocolMismatch, 'protocol mismatch');
}

/**
 * Cuts off every attachment persisted by an older build. Old pages cannot be upgraded in place:
 * a queued frame from them must never act on a v2 match, so the sweep runs once when the
 * instance wakes, before any frame is parsed. Returns how many attachments were closed.
 */
export function sweepStaleProtocolSockets(scope: RoomScope): number {
  let swept = 0;
  for (const ws of scope.sockets()) {
    const meta = readSocketMeta(ws);
    if (!meta || currentProtocolSocket(meta)) continue;
    rejectStaleSocket(scope, ws, meta);
    swept += 1;
  }
  return swept;
}

/** The identity a socket was accepted with, or `null` for anything that is not one of ours. */
export function readSocketMeta(ws: WebSocket): SocketAuth | null {
  const meta = ws.deserializeAttachment() as SocketAuth | null;
  if (!meta || typeof meta.userId !== 'string' || typeof meta.connId !== 'string') return null;
  return meta;
}

/**
 * The accounts a socket currently speaks for: a seat is online only while its
 * recorded `conn_id` matches a live socket, so a socket whose authority was
 * revoked, replaced or already released is not online even if its physical close
 * has not landed yet.
 */
export function onlineUserIds(
  players: readonly PlayerRow[],
  conns: ReadonlySet<string>,
): Set<string> {
  const online = new Set<string>();
  for (const row of players) {
    if (row.conn_id !== null && conns.has(row.conn_id)) online.add(row.user_id);
  }
  return online;
}

/**
 * Connection ids that are both recorded on a seat and backed by an open socket.
 * Everything that delivers state, decides who is online or hands over the host
 * resolves through this one set.
 */
export function currentConns(scope: RoomScope): Set<string> {
  const recorded = new Set<string>();
  for (const row of listPlayers(scope.sql)) {
    if (row.conn_id !== null) recorded.add(row.conn_id);
  }
  const conns = new Set<string>();
  for (const ws of scope.sockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = readSocketMeta(ws);
    // A stale-protocol attachment is not a receiver: it is not online, gets no
    // snapshots and never hands over the host. Cleanup is the sweep's job, not
    // this read path's.
    if (meta && currentProtocolSocket(meta) && recorded.has(meta.connId)) conns.add(meta.connId);
  }
  return conns;
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
export function unbindSocket(scope: RoomScope, meta: SocketAuth): boolean {
  scope.input.release(meta.connId);
  const room = getRoom(scope.sql);
  const player = getPlayer(scope.sql, meta.userId);
  if (!room || !player || player.conn_id !== meta.connId) return false;
  const keepSeatAlive = room.locked !== 0 || room.phase !== 'lobby';
  updatePlayer(scope.sql, meta.userId, {
    conn_id: null,
    slot_expires_at: keepSeatAlive ? null : Date.now() + SEAT_TTL_MS,
  });
  return true;
}

/** Sockets whose session has already expired: the alarm closes them even on an otherwise idle room. */
export function expiredSockets(
  scope: RoomScope,
  now: number,
): { ws: WebSocket; meta: SocketAuth }[] {
  const expired: { ws: WebSocket; meta: SocketAuth }[] = [];
  for (const ws of scope.sockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = readSocketMeta(ws);
    if (meta && meta.sessionExpires <= now) expired.push({ ws, meta });
  }
  return expired;
}

/**
 * Removes this room's session reference once no socket here still holds that
 * session open. Called only from inside the room's critical section, and it
 * never throws: a reference left behind only costs one no-op revocation later,
 * while an exception escaping a critical section would take the room with it.
 */
export async function dropSessionRef(
  scope: RoomScope,
  sessionHash: string,
  closing: WebSocket,
): Promise<void> {
  try {
    for (const ws of scope.sockets()) {
      if (ws === closing || ws.readyState !== WebSocket.OPEN) continue;
      const meta = readSocketMeta(ws);
      if (meta && meta.sessionHash === sessionHash) return;
    }
    const room = getRoom(scope.sql);
    if (!room) return;
    await unregisterSessionRoom(scope.env, sessionHash, room.id);
  } catch (error) {
    console.error(
      '[room] session reference cleanup failed',
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/**
 * Hands the room to the lowest-seated connected player whenever the host is
 * not a connected seat. A host who left the room is no longer in the roster
 * even while its socket is still open, so leaving in the lobby always hands
 * control over instead of stranding the remaining players. A host whose
 * connection was revoked counts as gone even if its close has not landed.
 */
export function reconcileHost(scope: RoomScope): void {
  const room = getRoom(scope.sql);
  if (!room) return;
  const roster = listPlayers(scope.sql);
  const online = onlineUserIds(roster, currentConns(scope));
  if (roster.some((row) => row.user_id === room.host_id) && online.has(room.host_id)) return;
  const candidate = roster.find((row) => online.has(row.user_id));
  if (!candidate) return;
  updateRoom(scope.sql, { host_id: candidate.user_id });
}

export function sendTo(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    console.error('[room] send failed', error instanceof Error ? error.name : typeof error);
  }
}

export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch (error) {
    console.error('[room] close failed', error instanceof Error ? error.name : typeof error);
  }
}

/** Tells every socket this instance owns that the room is over, then closes it. */
export function closeAllSockets(scope: RoomScope, code: number, reason: string): void {
  for (const ws of scope.sockets()) closeSocket(ws, code, reason);
}

/**
 * Closes every socket speaking for one account, terminal (`closed`), so every
 * tab of a departing account stops — not just the one that asked to leave.
 * Authority is the caller's concern: clear the seat's `conn_id` first when the
 * account must stop acting, then close.
 */
export function closeUserSockets(scope: RoomScope, userId: string, reason: string): void {
  for (const ws of scope.sockets()) {
    const meta = readSocketMeta(ws);
    if (meta && meta.userId === userId) closeSocket(ws, WS_CLOSE.closed, reason);
  }
}
