/**
 * 手动离场 — the explicit-departure contract shared by the `leave` lobby frame and the
 * authenticated `POST /api/rooms/:id/leave` endpoint.
 *
 * What is pinned here is the room's own decision, against a real SQLite engine:
 * an explicit departure forfeits the live match (duel settles immediately,
 * larger tables fight on, results keep their order), ordinary membership releases
 * stay idempotent under HTTP retries, a settled match's ranking is never
 * rewritten by a later leave, and an abandoned match can neither be read nor
 * re-entered — while an ordinary disconnect never reaches this routine at all.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_HEALTH } from '../../shared/protocol';
import type { Phase, ReservationState } from '../../shared/protocol';
import type { Env } from '../../worker/env';
import { matchIsLive } from '../../worker/matchmaking/rooms';
import { manualLeave } from '../../worker/rooms/leave';
import { handleClientFrame } from '../../worker/rooms/frames';
import { RoomRejection } from '../../worker/rooms/rejection';
import { InputBudget, type RoomScope } from '../../worker/rooms/scope';
import { snapshotFor } from '../../worker/rooms/snapshots';
import { abandonedMatch, getDeparture } from '../../worker/rooms/storage/departures';
import { getPlayer, insertPlayer, updatePlayer } from '../../worker/rooms/storage/players';
import { getRoom, insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
import type { SqlStore } from '../../worker/sql';
import { advanceOnce } from '../../worker/rooms/transitions';
import { openTestStorage, type TestStorage } from '../support/sql-storage';

const ROOM_ID = 'a'.repeat(24);
const NOW = 1_700_000_000_000;
const MATCH_ID = 'match-1';
/** Deadlines the room's own clock treats as due, and one far ahead of it. */
const PAST = Date.now() - 1;
const FUTURE = Date.now() + 100_000;

type StubSocket = WebSocket & { readyState: number };

function setup(
  userIds: readonly string[],
  room: {
    mode?: 'quick' | 'private';
    phase: Phase;
    reservationState?: ReservationState;
    reservationExpiresAt?: number | null;
    matchId?: string | null;
    deadline?: number;
    endReason?: 'elimination' | 'timeout' | null;
  },
): { storage: TestStorage; scope: RoomScope; sockets: StubSocket[]; closed: { userId: string }[] } {
  const storage = openTestStorage();
  createSchema(storage.sql);
  const closed: { userId: string }[] = [];
  const sockets = userIds.map((userId) => {
    const ws = {
      readyState: WebSocket.OPEN as number,
      deserializeAttachment: () => ({
        userId,
        username: userId,
        connId: `${userId}-conn`,
        sessionHash: `${userId}-session`,
        sessionExpires: Date.now() + 60_000,
      }),
      send: () => {},
      close: () => {
        closed.push({ userId });
        ws.readyState = WebSocket.CLOSED;
      },
    };
    return ws as unknown as StubSocket;
  });
  const scope: RoomScope = {
    sql: storage.sql,
    // Only the result-save batch and the duel index write ever reach D1 here.
    env: {
      DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => ({}) },
    } as unknown as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
  };
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: userIds[0],
    mode: room.mode ?? 'private',
    theme: '咒文契约',
    difficulty: 'hard',
    reservationState: room.reservationState ?? 'none',
    reservationExpiresAt: room.reservationExpiresAt ?? null,
    now: NOW,
  });
  updateRoom(storage.sql, {
    phase: room.phase,
    locked: room.phase === 'lobby' ? 0 : 1,
    match_id: room.matchId ?? null,
    deadline: room.deadline ?? 0,
    end_reason: room.endReason ?? null,
  });
  for (const userId of userIds) {
    insertPlayer(storage.sql, { userId, username: userId, slotExpiresAt: null, now: NOW });
    updatePlayer(storage.sql, userId, { seated: 1, conn_id: `${userId}-conn` });
  }
  return { storage, scope, sockets, closed };
}

function allResults(sql: SqlStore): { user_id: string; rank: number; hp_remaining: number }[] {
  return sql
    .exec<{ user_id: string; rank: number; hp_remaining: number }>(
      'SELECT user_id, rank, hp_remaining FROM match_results ORDER BY user_id',
    )
    .toArray();
}

describe('对局中离场', () => {
  it('双人局弃赛立即结算：对手获胜、双方成绩保留、离场者被永久拦下', async () => {
    const { storage, scope, closed } = setup(['host', 'guest'], {
      phase: 'playing',
      matchId: MATCH_ID,
      reservationState: 'locked',
      deadline: FUTURE,
    });
    try {
      updatePlayer(storage.sql, 'guest', { hp: 300, damage_dealt: 900 });
      await manualLeave(scope, 'guest');

      const room = getRoom(storage.sql)!;
      expect(room.phase).toBe('finished');
      expect(room.end_reason).toBe('elimination');
      expect(room.match_id).toBe(MATCH_ID);
      expect(room.reservation_state).toBe('none');

      const guest = getPlayer(storage.sql, 'guest')!;
      expect(guest.hp).toBe(0);
      expect(guest.eliminated_at).not.toBeNull();
      expect(getPlayer(storage.sql, 'host')!.hp).toBe(INITIAL_HEALTH);
      expect(abandonedMatch(storage.sql, 'guest', MATCH_ID)).toBe(true);

      const ranks = new Map(allResults(storage.sql).map((row) => [row.user_id, row.rank]));
      expect(ranks.get('host')).toBe(1);
      expect(ranks.get('guest')).toBe(2);

      expect(closed).toEqual([{ userId: 'guest' }]);

      expect(() => snapshotFor(scope, { id: 'guest', username: 'guest' })).toThrow(RoomRejection);
      const hostSnapshot = snapshotFor(scope, { id: 'host', username: 'host' });
      expect(hostSnapshot.phase).toBe('finished');
      expect(hostSnapshot.players.find((player) => player.id === 'guest')?.rank).toBe(2);
    } finally {
      storage.close();
    }
  });

  it('WebSocket 的 leave 帧与 HTTP 离场共享同一次弃赛', async () => {
    const { storage, scope, sockets } = setup(['host', 'guest'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    try {
      await handleClientFrame(scope, sockets[1], sockets[1].deserializeAttachment(), {
        type: 'leave',
      });
      expect(getRoom(storage.sql)!.phase).toBe('finished');
      expect(abandonedMatch(storage.sql, 'guest', MATCH_ID)).toBe(true);
      // 重放同一次离场是幂等成功，不再改写任何状态。
      await expect(manualLeave(scope, 'guest')).resolves.toBeUndefined();
      expect(getRoom(storage.sql)!.end_reason).toBe('elimination');
    } finally {
      storage.close();
    }
  });

  it('多人局一人弃赛，其余人的对局照常继续', async () => {
    const { storage, scope, closed } = setup(['host', 'guest', 'third'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    try {
      await manualLeave(scope, 'guest');

      const room = getRoom(storage.sql)!;
      expect(room.phase).toBe('playing');
      expect(room.end_reason).toBeNull();
      expect(getPlayer(storage.sql, 'guest')!.hp).toBe(0);
      expect(getPlayer(storage.sql, 'third')!.hp).toBe(INITIAL_HEALTH);
      expect(allResults(storage.sql)).toEqual([]);
      expect(closed).toEqual([{ userId: 'guest' }]);
      expect(abandonedMatch(storage.sql, 'guest', MATCH_ID)).toBe(true);
      expect(abandonedMatch(storage.sql, 'third', MATCH_ID)).toBe(false);

      const hostSnapshot = snapshotFor(scope, { id: 'host', username: 'host' });
      const guest = hostSnapshot.players.find((player) => player.id === 'guest')!;
      expect(guest.hp).toBe(0);
      expect(guest.eliminatedAt).not.toBeNull();
      expect(guest.connected).toBe(false);
    } finally {
      storage.close();
    }
  });

  it('已出局者的离场是幂等重放，不改写既有淘汰时间', async () => {
    const { storage, scope } = setup(['host', 'guest', 'third'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    try {
      updatePlayer(storage.sql, 'guest', { hp: 0, eliminated_at: NOW - 5_000 });
      await manualLeave(scope, 'guest');
      const first = getPlayer(storage.sql, 'guest')!;
      await manualLeave(scope, 'guest');
      expect(getPlayer(storage.sql, 'guest')).toMatchObject({
        hp: 0,
        eliminated_at: first.eliminated_at,
      });
      expect(getDeparture(storage.sql, 'guest')!.match_id).toBe(MATCH_ID);
      expect(getRoom(storage.sql)!.phase).toBe('playing');
    } finally {
      storage.close();
    }
  });
});

describe('开赛前离场', () => {
  it('生成期弃赛保留参与数据，出题后的续延也无法让弃赛者复活', async () => {
    const { storage, scope } = setup(['host', 'guest'], {
      phase: 'generating',
      matchId: MATCH_ID,
      reservationState: 'locked',
    });
    try {
      await manualLeave(scope, 'guest');
      expect(getRoom(storage.sql)!.phase).toBe('generating');
      expect(getPlayer(storage.sql, 'guest')).toMatchObject({ hp: 0, conn_id: null });
      expect(abandonedMatch(storage.sql, 'guest', MATCH_ID)).toBe(true);

      // 出题完成进入倒计时，倒计时到点：战斗开始的一刻按存活规则结算。
      updateRoom(storage.sql, { phase: 'countdown', deadline: PAST });
      await advanceOnce(scope);

      const room = getRoom(storage.sql)!;
      expect(room.phase).toBe('finished');
      expect(room.end_reason).toBe('elimination');
      const ranks = new Map(allResults(storage.sql).map((row) => [row.user_id, row.rank]));
      expect(ranks.get('host')).toBe(1);
      expect(ranks.get('guest')).toBe(2);
      expect(() => snapshotFor(scope, { id: 'guest', username: 'guest' })).toThrow(RoomRejection);
    } finally {
      storage.close();
    }
  });

  it('快速预约期离场取消整个预约，重放与未离场的对方都被如实拒绝', async () => {
    const { storage, scope, closed } = setup(['host', 'guest'], {
      mode: 'quick',
      phase: 'lobby',
      reservationState: 'reserved',
      reservationExpiresAt: FUTURE,
    });
    try {
      await manualLeave(scope, 'guest');

      const room = getRoom(storage.sql)!;
      expect(room.reservation_state).toBe('cancelled');
      expect(room.reservation_expires_at).toBeNull();
      expect(
        storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM players').one().total,
      ).toBe(0);
      expect(closed.map((entry) => entry.userId).sort()).toEqual(['guest', 'host']);
      expect(getDeparture(storage.sql, 'guest')!.match_id).toBeNull();

      await expect(manualLeave(scope, 'guest')).resolves.toBeUndefined();
      await expect(manualLeave(scope, 'host')).rejects.toThrow(RoomRejection);
    } finally {
      storage.close();
    }
  });

  it('开放大厅离场删除座位，离场标记让重放成功', async () => {
    const { storage, scope } = setup(['host', 'guest'], { phase: 'lobby' });
    try {
      await manualLeave(scope, 'guest');
      expect(getPlayer(storage.sql, 'guest')).toBeNull();
      expect(getPlayer(storage.sql, 'host')).not.toBeNull();
      expect(getDeparture(storage.sql, 'guest')).toMatchObject({ match_id: null });
      await expect(manualLeave(scope, 'guest')).resolves.toBeUndefined();
      // 从未入座者不是幂等重放，而是诚实的 404。
      await expect(manualLeave(scope, 'stranger')).rejects.toThrow(RoomRejection);
    } finally {
      storage.close();
    }
  });
});

describe('已结束的对局与匹配释放', () => {
  it('已结束对局的离场不改写任何名次与健康数据', async () => {
    const { storage, scope } = setup(['host', 'guest'], {
      phase: 'finished',
      matchId: MATCH_ID,
      deadline: 0,
      endReason: 'timeout',
    });
    try {
      updatePlayer(storage.sql, 'host', { hp: 640, eliminated_at: PAST });
      updatePlayer(storage.sql, 'guest', { hp: 300 });
      await manualLeave(scope, 'guest');

      expect(getPlayer(storage.sql, 'host')!.hp).toBe(640);
      expect(getPlayer(storage.sql, 'guest')).toMatchObject({ hp: 300, eliminated_at: null });
      expect(allResults(storage.sql)).toEqual([]);
      expect(getDeparture(storage.sql, 'guest')!.match_id).toBe(MATCH_ID);
      // 在场者读到的快照依旧带着完整名次。
      const hostSnapshot = snapshotFor(scope, { id: 'host', username: 'host' });
      expect(hostSnapshot.phase).toBe('finished');
      expect(hostSnapshot.players.find((player) => player.id === 'guest')?.hp).toBe(300);
    } finally {
      storage.close();
    }
  });

  it('matchIsLive 以资格为准：被拒绝的资格释放，房间不可达时保守保留', async () => {
    const binding = (stub: unknown): Env =>
      ({ ROOMS: { idFromName: (name: string) => name, get: () => stub } }) as unknown as Env;
    const rejecting = {
      matchEntitlement: () => Promise.reject(new RoomRejection('room:reservation_gone', '离开')),
    };
    const broken = { matchEntitlement: () => Promise.reject(new Error('rpc down')) };
    await expect(matchIsLive(binding(rejecting), 'guest', ROOM_ID)).resolves.toBe(false);
    // 不可达的房间保守地保留座位：绝不因此发出重复席位。
    await expect(matchIsLive(binding(broken), 'guest', ROOM_ID)).resolves.toBe(true);
  });
});
