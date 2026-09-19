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

/** The frames whose only actor is the lobby: readiness, the host's start, a rematch and a leave. */
export type LobbyFrame = Extract<ClientMessage, { type: 'ready' | 'start' | 'rematch' | 'leave' }>;

/**
 * Tells a socket about a refused new match. Maintenance admission is read
 * inside the caller's transaction, so the refusal and the state it guards
 * commit (or refuse) together — and nothing else in the branch was durable
 * yet, so the rollback carries no loss.
 */
function sendAdmissionRefusal(socket: RoomSocket, error: unknown): boolean {
  if (!(error instanceof MaintenanceError)) return false;
  sendTo(socket, { type: 'error', message: error.message });
  return true;
}

/**
 * Every lobby decision a seat can make. Each branch answers the socket itself and ends with the
 * room's own snapshot fan-out, so a caller never has to remember to push one.
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
          // Admission first: a draining server starts no new match, and the
          // refusal leaves the room exactly as it was.
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
          // Same gate as a first start: a rematch is a new match.
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

/** The host's start branch: every readiness rule, then the transactional match start. */
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
  // Reserved invitees that never connected are released at lock time; a
  // player who actually joined is never dropped silently.
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
  // A refused start records its reason on the room row, and the snapshot
  // below carries it to every seat either way.
  await startMatchTx(tx, scope.roomId, room, inputPolicyMode);
}

/** Returns a settled room to an open lobby for the next match. */
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
  // Seats that were held through the match expire again, so an absent
  // player cannot block the next start; the connected ones keep theirs.
  const roster = await listPlayers(tx, scope.roomId);
  const room = await getRoom(tx, scope.roomId);
  if (!room) throw new Error('room:not_found');
  const present = onlineUserIds(roster, await currentConns(tx, scope.roomId, scope.registry));
  for (const row of roster) if (participantKind(room, row) !== 'human') present.add(row.user_id);
  await armLobbySeatExpiry(tx, scope.roomId, [...present], Date.now() + SEAT_TTL_MS);
  await reconcileHost(tx, scope.roomId, scope.registry);
}
