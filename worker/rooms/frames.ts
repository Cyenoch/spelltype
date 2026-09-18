import { WS_CLOSE } from '../../shared/protocol';
import type { ClientMessage } from '../../shared/protocol';
import { handleInput } from './combat';
import { handleLobbyFrame } from './lobby';
import type { RoomScope } from './scope';
import { closeSocket, sendTo } from './sockets';
import type { SocketAuth } from './sockets';
import { getPlayer } from './storage/players';
import { getRoom } from './storage/room';

/**
 * The gate every client frame passes through before any branch may act on the room.
 *
 * A socket we have already decided to close — replaced, leaving, revoked or
 * expired by the session sweep — can still deliver frames that were queued
 * before that close. The close is the authority boundary, so a frame from a
 * non-open socket mutates nothing; the `conn_id` check below catches the rest.
 */
export async function handleClientFrame(
  scope: RoomScope,
  ws: WebSocket,
  meta: SocketAuth,
  message: ClientMessage,
): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  const sql = scope.sql;
  const room = getRoom(sql);
  if (!room) {
    sendTo(ws, { type: 'error', message: '房间不存在或已结束。' });
    closeSocket(ws, WS_CLOSE.closed, 'room gone');
    return;
  }
  const player = getPlayer(sql, meta.userId);
  if (!player) {
    sendTo(ws, { type: 'error', message: '你不在这个房间中。' });
    closeSocket(ws, WS_CLOSE.closed, 'not seated');
    return;
  }
  // A connection that a newer one replaced may not act any more.
  if (player.conn_id !== meta.connId) {
    sendTo(ws, { type: 'error', message: '连接已被新的登录替换。' });
    closeSocket(ws, WS_CLOSE.replaced, 'superseded');
    return;
  }
  if (message.type === 'ping') {
    sendTo(ws, { type: 'pong', serverNow: Date.now() });
    return;
  }
  if (message.type === 'input') return handleInput(scope, ws, meta, message);
  return handleLobbyFrame(scope, room, ws, meta, message);
}
