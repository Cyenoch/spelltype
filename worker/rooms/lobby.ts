import type { ClientMessage } from '../../shared/protocol';
import { startMatch } from './match';
import { manualLeave } from './leave';
import { MIN_PLAYERS, SEAT_TTL_MS } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds, reconcileHost, sendTo } from './sockets';
import type { SocketAuth } from './sockets';
import {
  armLobbySeatExpiry,
  clearReady,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from './storage/players';
import { updateRoom } from './storage/room';
import type { RoomRow } from './storage/schema';
import { scheduleAlarm } from './timers';

/** The frames whose only actor is the lobby: readiness, the host's start, a rematch and a leave. */
export type LobbyFrame = Extract<ClientMessage, { type: 'ready' | 'start' | 'rematch' | 'leave' }>;

/**
 * Every lobby decision a seat can make. Each branch answers the socket itself and ends with the
 * room's own snapshot fan-out, so a caller never has to remember to push one.
 */
export async function handleLobbyFrame(
  scope: RoomScope,
  room: RoomRow,
  ws: WebSocket,
  meta: SocketAuth,
  message: LobbyFrame,
): Promise<void> {
  const sql = scope.sql;
  switch (message.type) {
    case 'ready': {
      if (room.phase !== 'lobby' && room.phase !== 'generating') {
        sendTo(ws, { type: 'error', message: '比赛已开始，无法变更准备状态。' });
        return;
      }
      updatePlayer(sql, meta.userId, { ready: message.ready ? 1 : 0 });
      pushSnapshots(scope);
      return;
    }
    case 'start': {
      if (room.phase === 'generating') {
        sendTo(ws, { type: 'error', message: '正在出题，请稍候。' });
        return;
      }
      if (room.phase !== 'lobby') {
        sendTo(ws, { type: 'error', message: '比赛已经开始。' });
        return;
      }
      if (room.mode === 'quick' && room.reservation_state === 'reserved') {
        sendTo(ws, { type: 'error', message: '快速对战在双方到齐后自动开始。' });
        return;
      }
      if (room.host_id !== meta.userId) {
        sendTo(ws, { type: 'error', message: '只有房主可以开始比赛。' });
        return;
      }
      const roster = listPlayers(sql);
      const online = onlineUserIds(roster, currentConns(scope));
      // Reserved invitees that never connected are released at lock time; a
      // player who actually joined is never dropped silently.
      const missing = roster.filter((row) => row.seated === 1 && !online.has(row.user_id));
      if (missing.length > 0) {
        sendTo(ws, {
          type: 'error',
          message: `还有玩家未连接：${missing.map((row) => row.username).join('、')}。`,
        });
        return;
      }
      if (online.size < MIN_PLAYERS) {
        sendTo(ws, { type: 'error', message: '至少需要 2 名已连接玩家才能开始。' });
        return;
      }
      const others = roster.filter((row) => row.user_id !== meta.userId && row.seated === 1);
      if (others.some((row) => row.ready !== 1)) {
        sendTo(ws, { type: 'error', message: '还有玩家尚未准备。' });
        return;
      }
      // A refused start records its reason on the room row, and the snapshot
      // below carries it to every seat either way.
      startMatch(scope, room);
      pushSnapshots(scope);
      await scheduleAlarm(scope);
      return;
    }
    case 'rematch': {
      if (room.phase !== 'finished') {
        sendTo(ws, { type: 'error', message: '比赛尚未结束。' });
        return;
      }
      resetPlayersForMatch(sql);
      clearReady(sql);
      updateRoom(sql, {
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
      });
      // Seats that were held through the match expire again, so an absent
      // player cannot block the next start; the connected ones keep theirs.
      const roster = listPlayers(sql);
      armLobbySeatExpiry(
        sql,
        [...onlineUserIds(roster, currentConns(scope))],
        Date.now() + SEAT_TTL_MS,
      );
      reconcileHost(scope);
      pushSnapshots(scope);
      await scheduleAlarm(scope);
      return;
    }
    case 'leave': {
      // The same routine the HTTP leave endpoint runs: an explicit departure has
      // identical forfeit semantics on either transport, and it answers by
      // closing every socket of the departing account itself.
      await manualLeave(scope, meta.userId);
      return;
    }
  }
}
