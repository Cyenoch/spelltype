import type { ClientMessage, InputPolicyMode } from '../../shared/protocol';
import { MaintenanceError } from '../../shared/maintenance';
import { getRoom } from './storage/room';
import { assertAdmission } from '../maintenance/control';
import { startMatchTx } from './match';
import { manualLeave } from './leave';
import { MIN_PLAYERS, SEAT_TTL_MS } from './rules';
import type { RoomScope, SocketAuth } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds, reconcileHost, sendTo } from './sockets';
import {
  armLobbySeatExpiry,
  clearReady,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from './storage/players';
import { updateRoom } from './storage/room';
import type { RoomRow } from '../db/schema';
import type { RoomSocket } from '../contracts';
import type { Transaction } from '../db';
import { participantKind } from './opponents';

/** 仅针对大厅生效的数据帧：准备、房主开始、再来一局以及离开。 */
export type LobbyFrame = Extract<ClientMessage, { type: 'ready' | 'start' | 'rematch' | 'leave' }>;

/**
 * 向套接字通知新对局被拒绝。维护准入在调用方的事务内读取，
 * 因此拒绝响应与它所保护的状态会一起提交（或一起拒绝）——
 * 且该分支中尚无其他已持久化的变动，因此回滚不会造成数据丢失。
 */
function sendAdmissionRefusal(socket: RoomSocket, error: unknown): boolean {
  if (!(error instanceof MaintenanceError)) return false;
  sendTo(socket, { type: 'error', message: error.message });
  return true;
}

/**
 * 席位可在大厅作出的所有决策。每个分支自行回复套接字，
 * 并以向房间广播快照结束，调用方无需额外记住推送快照。
 */
export async function handleLobbyFrame(
  scope: RoomScope,
  room: RoomRow,
  socket: RoomSocket,
  meta: SocketAuth,
  message: LobbyFrame,
): Promise<void> {
  switch (message.type) {
    case 'ready': {
      if (room.phase !== 'lobby' && room.phase !== 'generating') {
        sendTo(socket, { type: 'error', message: '比赛已开始，无法变更准备状态。' });
        return;
      }
      await scope.transact(async (tx) => {
        await updatePlayer(tx, scope.roomId, meta.userId, { ready: message.ready ? 1 : 0 });
      });
      await pushSnapshots(scope);
      return;
    }
    case 'start': {
      try {
        await scope.transact(async (tx) => {
          // 准入优先：排空（draining）状态的服务器不开始新对局，
          // 且拒绝后房间状态保持完全不变。
          await assertAdmission(tx);
          const fresh = await getRoom(tx, scope.roomId);
          if (!fresh) {
            sendTo(socket, { type: 'error', message: '房间不存在或已结束。' });
            return;
          }
          await hostStartTx(tx, scope, socket, meta, fresh, scope.inputPolicyMode);
        });
      } catch (error) {
        if (sendAdmissionRefusal(socket, error)) return;
        throw error;
      }
      await pushSnapshots(scope);
      return;
    }
    case 'rematch': {
      try {
        await scope.transact(async (tx) => {
          // 与首次开始相同的限制门控：再来一局属于全新的对局。
          await assertAdmission(tx);
          const fresh = await getRoom(tx, scope.roomId);
          if (!fresh) {
            sendTo(socket, { type: 'error', message: '房间不存在或已结束。' });
            return;
          }
          if (fresh.phase !== 'finished') {
            sendTo(socket, { type: 'error', message: '比赛尚未结束。' });
            return;
          }
          await rematchTx(tx, scope);
        });
      } catch (error) {
        if (sendAdmissionRefusal(socket, error)) return;
        throw error;
      }
      await pushSnapshots(scope);
      return;
    }
    case 'leave': {
      await manualLeave(scope, meta.userId);
      return;
    }
  }
}

/** 房主开始对局分支：校验所有就绪规则，然后事务性开始对局。 */
async function hostStartTx(
  tx: Transaction,
  scope: RoomScope,
  socket: RoomSocket,
  meta: SocketAuth,
  room: RoomRow,
  inputPolicyMode: InputPolicyMode,
): Promise<void> {
  if (room.phase === 'generating') {
    sendTo(socket, { type: 'error', message: '正在出题，请稍候。' });
    return;
  }
  if (room.phase !== 'lobby') {
    sendTo(socket, { type: 'error', message: '比赛已经开始。' });
    return;
  }
  if (room.mode === 'quick' && room.reservation_state === 'reserved') {
    sendTo(socket, { type: 'error', message: '快速对战在双方到齐后自动开始。' });
    return;
  }
  if (room.host_id !== meta.userId) {
    sendTo(socket, { type: 'error', message: '只有房主可以开始比赛。' });
    return;
  }
  const roster = await listPlayers(tx, scope.roomId);
  const online = onlineUserIds(roster, await currentConns(tx, scope.roomId, scope.registry));
  for (const row of roster) if (participantKind(room, row) !== 'human') online.add(row.user_id);
  // 从未连接的预留受邀者在锁定对局时被释放；
  // 实际已加入的玩家绝不会被静默移除。
  const missing = roster.filter((row) => row.seated === 1 && !online.has(row.user_id));
  if (missing.length > 0) {
    sendTo(socket, {
      type: 'error',
      message: `还有玩家未连接：${missing.map((row) => row.username).join('、')}。`,
    });
    return;
  }
  if (online.size < MIN_PLAYERS) {
    sendTo(socket, { type: 'error', message: '至少需要 2 名已连接玩家才能开始。' });
    return;
  }
  const others = roster.filter((row) => row.user_id !== meta.userId && row.seated === 1);
  if (others.some((row) => participantKind(room, row) === 'human' && row.ready !== 1)) {
    sendTo(socket, { type: 'error', message: '还有玩家尚未准备。' });
    return;
  }
  // 被拒绝的开始操作会将其原因记录在房间数据行上，
  // 下方的快照无论如何都会将该错误同步给每个席位。
  await startMatchTx(tx, scope.roomId, room, inputPolicyMode);
}

/** 将已结算的房间恢复为开放大厅以进行下一场对局。 */
async function rematchTx(tx: Transaction, scope: RoomScope): Promise<void> {
  await resetPlayersForMatch(tx, scope.roomId);
  await clearReady(tx, scope.roomId);
  await updateRoom(tx, scope.roomId, {
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
    opponent_next_at: null,
  });
  // 在对局期间被保留的席位重新启用过期计时，防止离开的玩家阻塞下一次开始；
  // 保持连接的玩家则维持其席位。
  const roster = await listPlayers(tx, scope.roomId);
  const room = await getRoom(tx, scope.roomId);
  if (!room) throw new Error('room:not_found');
  const present = onlineUserIds(roster, await currentConns(tx, scope.roomId, scope.registry));
  for (const row of roster) if (participantKind(room, row) !== 'human') present.add(row.user_id);
  await armLobbySeatExpiry(tx, scope.roomId, [...present], Date.now() + SEAT_TTL_MS);
  await reconcileHost(tx, scope.roomId, scope.registry);
}
