import { WS_CLOSE } from '../../shared/protocol';
import type { ClientMessage } from '../../shared/protocol';
import type { RoomSocket } from '../contracts';
import { handleInput } from './combat';
import { handleLobbyFrame } from './lobby';
import type { RoomScope, SocketAuth } from './scope';
import { pushSnapshots } from './snapshots';
import { closeSocket, reconcileHost, sendTo } from './sockets';
import { getPlayer, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { unbindSeat } from './sockets';

/**
 * The gate every client frame passes through before any branch may act on the room.
 *
 * A socket we have already decided to close — replaced, leaving, revoked or
 * expired by the session sweep — can still deliver frames that were queued
 * before that close. The close is the authority boundary, so a frame from a
 * non-open socket mutates nothing; the `conn_id` check below catches the rest.
 *
 * Input frames also spend the per-connection quota here, right after ownership
 * and before any combat work: every legal packet counts, stale identities
 * included, and a connection that overspends its window is cut off once —
 * stripped of the seat, closed, and restored to the room's lifecycle — without
 * ever reaching the judging code.
 */
export async function handleClientFrame(
  scope: RoomScope,
  socket: RoomSocket,
  meta: SocketAuth,
  message: ClientMessage,
): Promise<void> {
  if (socket.readyState !== 1) return;
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) {
    sendTo(socket, { type: 'error', message: '房间不存在或已结束。' });
    closeSocket(socket, WS_CLOSE.closed, 'room gone');
    return;
  }
  const player = await getPlayer(scope.db, scope.roomId, meta.userId);
  if (!player) {
    sendTo(socket, { type: 'error', message: '你不在这个房间中。' });
    closeSocket(socket, WS_CLOSE.closed, 'not seated');
    return;
  }
  // A connection that a newer one replaced may not act any more.
  if (player.conn_id !== meta.connId) {
    sendTo(socket, { type: 'error', message: '连接已被新的登录替换。' });
    closeSocket(socket, WS_CLOSE.replaced, 'superseded');
    return;
  }
  if (message.type === 'ping') {
    sendTo(socket, { type: 'pong', serverNow: scope.now() });
    return;
  }
  if (message.type === 'input') {
    if (!scope.input.allow(meta.connId, scope.now())) {
      // The quota is spent once per overload — each one closes this connection,
      // so it cannot recur here — while the persistent counter records only a
      // playing match's overloads, in the same committed block that strips the
      // seat of this connection: the metric never lands without the revocation.
      const playing = room.phase === 'playing' && room.match_id !== null;
      const released = await scope.transact(async (tx) => {
        const unbound = await unbindSeat(tx, scope.roomId, meta, scope.now());
        if (playing && unbound) {
          await updatePlayer(tx, scope.roomId, meta.userId, {
            input_overloads: player.input_overloads + 1,
          });
        }
        return unbound;
      });
      scope.input.release(meta.connId);
      closeSocket(socket, WS_CLOSE.inputOverload, 'input overload');
      // One bounded line per overload, machine fields only — a match scope for
      // the metric, nulls outside a match, and never an identity or a payload.
      console.error({
        event: 'input_overload',
        matchId: playing ? room.match_id : null,
        policyVersion: playing ? room.input_policy_version : null,
        mode: playing ? room.input_policy_mode : null,
        reason: 'input_overload',
        count: 1,
      });
      if (!released) return;
      // The early unbind makes this socket's close callback find the seat
      // already released and skip the lifecycle, so the trio runs here instead.
      await scope.transact((tx) => reconcileHost(tx, scope.roomId, scope.registry));
      await pushSnapshots(scope);
      await scope.arm();
      return;
    }
    return handleInput(scope, socket, meta, message);
  }
  if (
    message.type === 'ready' ||
    message.type === 'start' ||
    message.type === 'rematch' ||
    message.type === 'leave'
  ) {
    return handleLobbyFrame(scope, room, socket, meta, message);
  }
}
