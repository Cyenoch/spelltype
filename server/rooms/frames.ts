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
 * 任何分支对房间执行操作之前，所有客户端数据帧必须通过的网关。
 *
 * 我们已决定关闭的套接字 —— 被替换、正在离开、被撤销或被会话扫描判定过期 ——
 * 仍可能交付在关闭之前已排队的数据帧。
 * 关闭是权限分界线，因此来自非打开套接字的数据帧不会修改任何状态；
 * 下方的 `conn_id` 检查会拦截剩余的情况。
 *
 * 输入数据帧也会在此处扣除单连接配额，紧跟所有权验证之后且在任何战斗逻辑之前：
 * 每一个合法数据包均计入，包括陈旧的身份信息；
 * 超过其时间窗口配额的连接会被立即切断一次 ——
 * 剥离席位、关闭连接并恢复房间的生命周期 —— 甚至绝不会触及裁决代码。
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
  // 已被新连接替换的旧连接不可再执行操作。
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
      // 配额在每次超载时扣除一次 —— 每次超载均会关闭此连接，
      // 因此此处不会重复触发 —— 而持久化计数器仅记录进行中对局的超载情况，
      // 且与剥离该连接席位处于同一个已提交的代码块中：该指标绝不会在未撤销的情况下落地。
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
      // 每次超载仅输出单行受控日志，仅包含机器字段 —— 包含指标对应的对局作用域，
      // 对局外为 null，且绝不包含身份或任何输入载荷。
      console.error({
        event: 'input_overload',
        matchId: playing ? room.match_id : null,
        policyVersion: playing ? room.input_policy_version : null,
        mode: playing ? room.input_policy_mode : null,
        reason: 'input_overload',
        count: 1,
      });
      if (!released) return;
      // 提前解绑使得此套接字的关闭回调发现席位已被释放并跳过生命周期处理，
      // 因此三部曲改在此处执行。
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
