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

/** Bun 复用了标准 WebSocket 就绪状态常量；1 为打开（open）。 */
const WS_OPEN = 1;

/** 针对每一次协议不匹配的握手和过期连接所通知的唯一次刷新提示。 */
export const PROTOCOL_REFRESH_MESSAGE = '客户端版本已更新，请刷新页面后继续。';

/** 当连接所采用的网络传输协议与本构建版本完全一致时返回 true。 */
export function currentProtocolSocket(meta: SocketAuth): boolean {
  return meta.protocolVersion === WS_PROTOCOL;
}

/**
 * 当前套接字所代表的账户：席位仅在记录的 `conn_id` 匹配活跃套接字时才视为在线，
 * 因此权限已被撤销、替换或已释放的套接字即使物理关闭尚未完成，
 * 也不再被视作在线。
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
 * 既记录在席位上、又由处于打开状态的套接字支撑的连接 ID。
 * 所有涉及状态分发、判定谁在线或移交房主的操作均通过该集合解析。
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
    // 旧协议连接不是有效接收者：它不在线、不接收快照，且绝不会被移交房主。
    // 清理属于唤醒扫描的职责，而非此读取路径的工作。
    if (meta && currentProtocolSocket(meta) && recorded.has(meta.connId)) conns.add(meta.connId);
  }
  return conns;
}

/**
 * 释放单个套接字对其席位的占用 —— 数据库层面。
 *
 * `conn_id` 是席位的权限凭证，因此对于关闭、替换和撤销只有唯一的一条规则：
 * 仅当席位指向该套接字时才将其清除。
 * 这使得被替换或撤销的连接立即停止算作玩家的有效套接字，
 * 无论其实际物理关闭何时完成。在调用方的事务内执行。
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
 * 剥离陈旧协议连接的权限，提示其刷新并以协议不匹配状态码将其关闭。
 * 调用方最终执行常规的协调/快照/告警三部曲 ——
 * 每次扫描执行一次，而非按套接字执行 —— 因为提前解绑使得关闭回调会跳过它们。
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
 * 切断所有未使用本构建版本网络传输协议的连接。
 * 无法指明该协议的页面绝不是可兼容的历史版本方言：其排队帧绝不能对正在进行的对局生效，
 * 因此扫描在解析来自该连接的任何帧之前运行。
 * 返回被切断的连接数；调用方负责执行协调/快照/告警三部曲。
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

/** 会话已经过期的套接字：追赶处理即使在空闲房间中也会将其关闭。 */
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
 * 当本房间不再有任何套接字保持该会话处于打开状态时，移除本房间对该会话的引用。
 * 绝不抛出异常：残留的引用后续最多只会导致一次空操作撤销，
 * 而从关闭路径逃逸的异常则会导致房间自身的清理流程崩溃。
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
 * 当房主不是已连接的席位时，将房间移交给席位序号最小的已连接玩家。
 * 离开房间的房主即使其套接字仍处于打开状态也不再存在于花名册中，
 * 因此在大厅离开总是会移交控制权，防止剩余玩家被搁置困住。
 * 连接已被撤销的房主即使其物理关闭尚未完成也被视为已离开。
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

/** 向本房间跟踪的每个套接字通知房间已结束，随后将其关闭。 */
export function closeAllSockets(registry: SocketRegistry, code: number, reason: string): void {
  for (const socket of registry.list()) closeSocket(socket, code, reason);
}

/**
 * 关闭代表特定账户的所有套接字，终局状态（`closed`），
 * 使得离开账户的所有标签页均停止工作 —— 而不仅仅是发起离开请求的那一个标签页。
 * 权限由调用方负责：当该账户必须停止操作时，先清除席位的 `conn_id`，然后关闭连接。
 */
export function closeUserSockets(registry: SocketRegistry, userId: string, reason: string): void {
  for (const socket of registry.list()) {
    const meta = registry.metaOf(socket);
    if (meta && meta.userId === userId) closeSocket(socket, WS_CLOSE.closed, reason);
  }
}
