import { WS_CLOSE, WS_PROTOCOL } from '../../shared/protocol';
import type { ServerMessage } from '../../shared/protocol';
import { unregisterSessionRoom } from './storage/room-sessions';
import type { PlayerRow, RoomRow } from '../db/schema';
import type { RoomSocket } from '../contracts';
import { SEAT_TTL_MS } from './rules';
import type { RoomScope, SocketAuth, SocketRegistry } from './scope';
import { getPlayer, listPlayers, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import type { RoomQuery } from './storage/query';

/** Bun reuses the standard WebSocket ready-state constants; open is 1. */
const WS_OPEN = 1;

/** The refresh message every non-v2 handshake and stale attachment is told exactly once. */
export const PROTOCOL_REFRESH_MESSAGE = '客户端版本已更新，请刷新页面后继续。';

/** True when an attachment speaks exactly the wire protocol this build serves. */
export function currentProtocolSocket(meta: SocketAuth): boolean {
  return meta.protocolVersion === WS_PROTOCOL;
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
export async function currentConns(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
): Promise<Set<string>> {
  const recorded = new Set<string>();
  for (const row of await listPlayers(db, roomId)) {
    if (row.conn_id !== null) recorded.add(row.conn_id);
  }
  const conns = new Set<string>();
  for (const socket of registry.list()) {
    if (socket.readyState !== WS_OPEN) continue;
    const meta = registry.metaOf(socket);
    // A stale-protocol attachment is not a receiver: it is not online, gets no
    // snapshots and never hands over the host. Cleanup is the sweep's job, not
    // this read path's.
    if (meta && currentProtocolSocket(meta) && recorded.has(meta.connId)) conns.add(meta.connId);
  }
  return conns;
}

/**
 * Releases one socket's hold on its seat — the database half.
 *
 * `conn_id` is the seat's authority, so there is exactly one rule for a close,
 * a replacement and a revocation: the seat is cleared only when this socket is
 * the one it points at. That makes a superseded or revoked connection stop
 * counting as the player's socket immediately, independent of whether its
 * physical close ever lands. Runs inside the caller's transaction.
 */
export async function unbindSeat(
  db: RoomQuery,
  roomId: string,
  meta: SocketAuth,
  now: number,
): Promise<boolean> {
  const room = await getRoom(db, roomId);
  const player = await getPlayer(db, roomId, meta.userId);
  if (!room || !player || player.conn_id !== meta.connId) return false;
  const keepSeatAlive = room.locked !== 0 || room.phase !== 'lobby';
  await updatePlayer(db, roomId, meta.userId, {
    conn_id: null,
    slot_expires_at: keepSeatAlive ? null : now + SEAT_TTL_MS,
  });
  return true;
}

/**
 * Strips one stale-protocol attachment of its authority, tells it to refresh and closes it with
 * the protocol-mismatch code. The caller finishes with the usual reconcile/snapshot/alarm trio —
 * once per sweep, not per socket — because the early unbind makes the close callback skip them.
 */
export async function rejectStaleSocket(
  scope: RoomScope,
  socket: RoomSocket,
  meta: SocketAuth,
): Promise<void> {
  scope.input.release(meta.connId);
  await scope.transact((tx) => unbindSeat(tx, scope.roomId, meta, scope.now()));
  sendTo(socket, { type: 'error', message: PROTOCOL_REFRESH_MESSAGE });
  closeSocket(socket, WS_CLOSE.protocolMismatch, 'protocol mismatch');
}

/**
 * Cuts off every attachment that does not speak this build's wire protocol. A page that cannot
 * name the protocol is never a working legacy dialect: a queued frame from it must never act
 * on a v2 match, so the sweep runs before any frame from the attachment is parsed. Returns how
 * many attachments were cut off; the caller owns the reconcile/snapshot/alarm trio.
 */
export async function sweepStaleProtocolSockets(scope: RoomScope): Promise<number> {
  let swept = 0;
  for (const socket of scope.registry.list()) {
    const meta = scope.registry.metaOf(socket);
    if (!meta || currentProtocolSocket(meta)) continue;
    await rejectStaleSocket(scope, socket, meta);
    swept += 1;
  }
  return swept;
}

/** Sockets whose session has already expired: the catch-up closes them even on an otherwise idle room. */
export function expiredSockets(
  registry: SocketRegistry,
  now: number,
): { socket: RoomSocket; meta: SocketAuth }[] {
  const expired: { socket: RoomSocket; meta: SocketAuth }[] = [];
  for (const socket of registry.list()) {
    if (socket.readyState !== WS_OPEN) continue;
    const meta = registry.metaOf(socket);
    if (meta && meta.sessionExpires <= now) expired.push({ socket, meta });
  }
  return expired;
}

/**
 * Removes this room's session reference once no socket here still holds that
 * session open. It never throws: a reference left behind only costs one no-op
 * revocation later, while an exception escaping a close path would take the
 * room's cleanup with it.
 */
export async function dropSessionRef(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
  sessionHash: string,
  closing: RoomSocket,
): Promise<void> {
  try {
    for (const socket of registry.list()) {
      if (socket === closing || socket.readyState !== WS_OPEN) continue;
      const meta = registry.metaOf(socket);
      if (meta && meta.sessionHash === sessionHash) return;
    }
    await unregisterSessionRoom(db, sessionHash, roomId);
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
export async function reconcileHost(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
): Promise<void> {
  const room: RoomRow | null = await getRoom(db, roomId);
  if (!room) return;
  const roster = await listPlayers(db, roomId);
  const online = onlineUserIds(roster, await currentConns(db, roomId, registry));
  if (roster.some((row) => row.user_id === room.host_id) && online.has(room.host_id)) return;
  const candidate = roster.find((row) => online.has(row.user_id));
  if (!candidate) return;
  await updateRoom(db, roomId, { host_id: candidate.user_id });
}

export function sendTo(socket: RoomSocket, message: ServerMessage): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error('[room] send failed', error instanceof Error ? error.name : typeof error);
  }
}

export function closeSocket(socket: RoomSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch (error) {
    console.error('[room] close failed', error instanceof Error ? error.name : typeof error);
  }
}

/** Tells every socket this room tracks that the room is over, then closes it. */
export function closeAllSockets(registry: SocketRegistry, code: number, reason: string): void {
  for (const socket of registry.list()) closeSocket(socket, code, reason);
}

/**
 * Closes every socket speaking for one account, terminal (`closed`), so every
 * tab of a departing account stops — not just the one that asked to leave.
 * Authority is the caller's concern: clear the seat's `conn_id` first when the
 * account must stop acting, then close.
 */
export function closeUserSockets(registry: SocketRegistry, userId: string, reason: string): void {
  for (const socket of registry.list()) {
    const meta = registry.metaOf(socket);
    if (meta && meta.userId === userId) closeSocket(socket, WS_CLOSE.closed, reason);
  }
}
