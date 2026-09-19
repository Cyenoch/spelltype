import { WS_CLOSE } from '../../shared/protocol';
import type { ReservationState } from '../../shared/protocol';
import type { RoomRow } from '../db/schema';
import { reservationIsLive } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeAllSockets } from './sockets';
import { deleteAllPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';

/**
 * 用于匹配协调对齐的预留状态，根据时钟进行标准化归一：
 * `reserved` 表示活跃的赛前预留，`locked` 表示比赛正在生成或进行中，
 * 其他所有状态（`none`、`cancelled`、`expired`）均不持有配额分配，因此可以丢弃排队凭证。
 * 从未初始化的房间 ID 返回 `none` 而非报错，并且截止时间已过的预留在执行清理的追赶任务运行之前
 * 即直接判定为 `expired`。共享数据库使得该状态在协调层面作为普通读取即可获取。
 */
export function reservationStateOf(room: RoomRow | null, now: number): ReservationState {
  if (!room) return 'none';
  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    !reservationIsLive(room, now)
  )
    return 'expired';
  return room.reservation_state;
}

/**
 * 结束一个活跃的快速匹配预留：释放两个席位，通知所有套接字后将其关闭。
 * 在调用方的隔离界限下重新读取决策，因此协调调度层已经取消的预留
 * 绝不会被过期的超时判定所覆盖，且中途已经开始的比赛绝不会被触及。
 * 携带原因的最终快照会在套接字关闭前送达各席位，正如旧架构所发送的数据帧一样。
 * 返回本次调用是否实际终结了该预留。
 */
export async function endReservation(
  scope: RoomScope,
  state: 'cancelled' | 'expired',
  message: string,
): Promise<boolean> {
  let ended = false;
  await scope.transact(async (tx) => {
    const room = await getRoom(tx, scope.roomId);
    if (!room || room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return;
    if (room.reservation_state !== 'reserved') return;
    await updateRoom(tx, scope.roomId, {
      reservation_state: state,
      reservation_expires_at: null,
      error: message,
    });
    ended = true;
  });
  if (!ended) return false;
  await pushSnapshots(scope);
  await scope.transact(async (tx) => deleteAllPlayers(tx, scope.roomId));
  closeAllSockets(scope.registry, WS_CLOSE.closed, state);
  return true;
}
