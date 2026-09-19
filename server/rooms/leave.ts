import type { RoomRow } from '../db/schema';
import { finishMatchTx } from './match';
import { RoomRejection } from './rejection';
import { endReservation } from './reservation';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeUserSockets, reconcileHost } from './sockets';
import { abandonedMatch, getDeparture, recordDeparture } from './storage/departures';
import { deletePlayer, getPlayer, listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readVolley } from './storage/volley';
import { advanceCombat } from './volleys';

/**
 * 单个账户的主动手动离开 —— `leave` 大厅数据帧以及经过身份验证的房间离开接口
 * 背后的唯一定义例程。
 *
 * 离开是一项主动决策，而非意外断线：浏览器关闭、网络故障或页面刷新
 * 绝不会触发此例程，因此所有常规断线均保留其重连语义。
 * 该例程所提交的变动对该账户具有永久性：
 * 释放席位、关闭连接，且放弃当前对局后绝无法重新进入 ——
 * 与此同时，其他人的对局和所有结果数据行继续正常运行不受影响。
 *
 * 设计上具备幂等性：在已提交离开后重放离开操作，会检测到离开记录并再次返回成功，
 * 从而确保丢失响应后的 HTTP 重试不会报错失败。
 * 对于该账户从未归属过的房间，将返回 `room:not_found` 拒绝，而非静默成功。
 *
 * 在离开可能改变生存状态之前，先结算所有到期的战斗。回复紧随持久化的离开标记发出，
 * 因此观察到成功的调用方可以确信弃权、席位释放以及匹配对齐均已就绪。
 */
export async function manualLeave(scope: RoomScope, userId: string): Promise<void> {
  let room = await getRoom(scope.db, scope.roomId);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  const player = await getPlayer(scope.db, scope.roomId, userId);

  if (!player) {
    // 已提交的历史离开操作在此重放视为成功；其他情况则代表从未在此入座。
    if ((await getDeparture(scope.db, scope.roomId, userId)) !== null) return;
    throw new RoomRejection('room:not_found', '你不在这个房间中。');
  }

  const now = scope.now();
  if (room.phase === 'playing') {
    // 时钟或已接受的批次先于离开操作到达：优先在其持久化的边界上进行结算，
    // 确保离开既不会延长超出唯一截止时间的对局，也不会打乱批次已裁决的排名。
    while (await advanceCombat(scope, now)) {
      // 在提交离开之前，先排空更早的合成动作及其批次。
    }
    room = (await getRoom(scope.db, scope.roomId))!;
  }
  if (room.mode === 'quick' && room.phase === 'lobby' && room.locked === 0) {
    if (room.reservation_state === 'reserved') {
      // 赛前匹配配对：一方离开将取消整个预留，
      // 为队列释放两个席位（沿用现有的预留语义）。
      await scope.transact(async (tx) =>
        recordDeparture(tx, scope.roomId, { userId, matchId: null, now }),
      );
      await endReservation(scope, 'cancelled', '对手已离开，请重新匹配。');
      return;
    }
    return openLobbyLeave(scope, userId, now);
  }
  if (room.phase === 'lobby' && room.locked === 0) return openLobbyLeave(scope, userId, now);
  if (room.phase === 'finished') return finishedLeave(scope, room, userId, now);
  return forfeit(scope, room, userId, now);
}

/** 开放大厅不包含对局：席位被删除，并可被新加入的玩家重新占据。 */
async function openLobbyLeave(scope: RoomScope, userId: string, now: number): Promise<void> {
  await scope.transact(async (tx) => {
    await deletePlayer(tx, scope.roomId, userId);
    await recordDeparture(tx, scope.roomId, { userId, matchId: null, now });
    await reconcileHost(tx, scope.roomId, scope.registry);
  });
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
}

/**
 * 已结算比赛的排名已持久化；离开该比赛仅会释放连接和权限，
 * 绝不会删除结果数据行或修改名次。
 */
async function finishedLeave(
  scope: RoomScope,
  room: RoomRow,
  userId: string,
  now: number,
): Promise<void> {
  await scope.transact(async (tx) =>
    recordDeparture(tx, scope.roomId, { userId, matchId: room.match_id, now }),
  );
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
}

/**
 * 对局正在生成或进行中：离开即视为认输弃权。
 *
 * 离开者将退出战斗（在离开瞬间生命值归零），从而确保排名与结果保持忠实次序，
 * 胜负判定从该状态继续推演：决斗在任何已提交的齐射落地后结束；
 * 仍有对手的多人牌桌则继续战斗。
 * 在生成或倒计时期间，相同状态预先提交，因此延迟的后续流程绝不会复活被放弃的席位。
 * 决出决斗胜负的弃权将在同一事务内完成比赛结算 —— 淘汰与历史记录行一同提交。
 */
async function forfeit(
  scope: RoomScope,
  room: RoomRow,
  userId: string,
  now: number,
): Promise<void> {
  const matchId = room.match_id;
  if (matchId === null) {
    // 无法触发：锁定的房间始终携带其对局 ID。
    // 诚实地拒绝，而非胡乱猜测不变量违背的含义。
    throw new Error('room:leave_without_match');
  }
  if (await abandonedMatch(scope.db, scope.roomId, userId, matchId)) {
    // 本场比赛此前已认输（重放离开）：仅释放连接。
    closeUserSockets(scope.registry, userId, 'left');
    return;
  }
  // 离开属于单个已提交的事务块：放弃标记、退出战斗、恢复离开指标以及席位失去连接
  // 要么全部提交，要么完全不提交 —— 崩溃会导致席位要么完全在比赛中，要么完全退出，
  // 绝不会处于已被淘汰但仍保持连接的状态。
  await scope.transact(async (tx) => {
    const fresh = await getRoom(tx, scope.roomId);
    if (!fresh || fresh.match_id !== matchId) throw new Error('room:leave_match_changed');
    await recordDeparture(tx, scope.roomId, { userId, matchId, now });
    const player = await getPlayer(tx, scope.roomId, userId);
    if (player === null) throw new Error('room:leave_seat_vanished');
    if (player.eliminated_at === null) {
      await updatePlayer(tx, scope.roomId, userId, {
        hp: 0,
        eliminated_at: now,
        // 仅在法术打字中途放弃活跃的进行中世代：已提交的施法、
        // 在战斗中失去的席位或未开始的比赛均无未完成的世代可计入。
        input_recovery_departures:
          player.input_recovery_departures +
          Number(fresh.phase === 'playing' && player.draft_epoch > 0),
      });
    }
    // 席位在套接字关闭之前便停止指向任何连接，因此排在关闭之前的帧无法对该账户已离开的比赛执行操作。
    await updatePlayer(tx, scope.roomId, userId, { conn_id: null, slot_expires_at: null });
    await reconcileHost(tx, scope.roomId, scope.registry);
    if (fresh.phase === 'playing') {
      const alive = (await listPlayers(tx, scope.roomId)).filter(
        (row) => row.eliminated_at === null,
      ).length;
      // 已提交的施法即使施法者刚刚弃权也依然有效：
      // 当窗口处于开启状态时，比赛会等待其落地生效，正如定时器所做的那样 ——
      // 在其下方直接结算将丢弃施法者自身的提交。
      if (alive <= 1 && (await readVolley(tx, scope.roomId)) === null) {
        // 弃权已决出胜负：立即进行结算，与战斗击倒（KO）完全一致。
        await finishMatchTx(tx, scope.roomId, 'elimination', now);
      }
    }
  });
  closeUserSockets(scope.registry, userId, 'left');
  await pushSnapshots(scope);
}
