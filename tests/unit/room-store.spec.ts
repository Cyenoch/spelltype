/**
 * Room state-layer unit tests — the Durable Object's own SQL, against a real SQLite engine.
 *
 * Kept to the state transitions that lose, duplicate or leak player data when they are wrong: opening
 * the schema, seat allocation/expiry, the bounded event ring, the per-match reset and the results
 * queue's idempotency key. `tests/support/sql-storage.ts` gives `node:sqlite` the workerd `SqlStorage`
 * surface, so these run in milliseconds instead of through a booted room.
 */
import { describe, expect, it } from 'vitest';
import { COMBAT_EVENT_RING_SIZE, INITIAL_HEALTH, type CombatEvent } from '../../shared/protocol';
import { appendEvent, readEvents } from '../../worker/rooms/storage/events';
import {
  abandonedMatch,
  getDeparture,
  recordDeparture,
} from '../../worker/rooms/storage/departures';
import {
  armLobbySeatExpiry,
  countPlayers,
  deletePlayer,
  deleteReservedSeats,
  expireSeats,
  getPlayer,
  insertPlayer,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from '../../worker/rooms/storage/players';
import {
  countUnsavedResults,
  listUnsavedResults,
  markResultsSaved,
  queueResults,
} from '../../worker/rooms/storage/results';
import { getRoom, insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
import { openTestStorage, type TestStorage } from '../support/sql-storage';

const ROOM_ID = 'a'.repeat(24);
const NOW = 1_700_000_000_000;

/** An empty database with the current layout and one lobby room in it. */
function withRoom(): TestStorage {
  const storage = openTestStorage();
  createSchema(storage.sql);
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: 'host-1',
    mode: 'private',
    theme: '咒文契约',
    difficulty: 'hard',
    reservationState: 'none',
    reservationExpiresAt: null,
    now: NOW,
  });
  return storage;
}

function seat(storage: TestStorage, userId: string, slotExpiresAt: number | null = null): void {
  insertPlayer(storage.sql, { userId, username: userId, slotExpiresAt, now: NOW });
}

function event(seq: number): CombatEvent {
  return {
    seq,
    at: NOW + seq,
    attackerId: 'host-1',
    targetId: 'guest-1',
    element: 'fire',
    damage: 4,
    targetHp: 100,
    spellIndex: 0,
    eliminated: false,
  };
}

function resultRow(matchId: string) {
  return {
    match_id: matchId,
    user_id: 'host-1',
    theme: '咒文契约',
    damage_dealt: 100,
    hp_remaining: INITIAL_HEALTH,
    spells_cast: 1,
    correct_chars: 11,
    duration_ms: 30_000,
    rank: 1,
    cpm: 120,
    accuracy: 1,
    created_at: NOW,
  };
}

describe('表结构', () => {
  it('重复打开数据库不丢弃已存在的房间与座位', () => {
    const storage = withRoom();
    try {
      seat(storage, 'host-1');
      createSchema(storage.sql);
      expect(getRoom(storage.sql)?.id).toBe(ROOM_ID);
      expect(listPlayers(storage.sql).map((player) => player.user_id)).toEqual(['host-1']);
    } finally {
      storage.close();
    }
  });
});

describe('座位', () => {
  it('按最小空位分配，满四人后拒绝第五人，空出的座位被复用', () => {
    const storage = withRoom();
    try {
      for (const id of ['a', 'b', 'c', 'd']) seat(storage, id);
      expect(listPlayers(storage.sql).map((player) => player.slot)).toEqual([0, 1, 2, 3]);
      expect(
        insertPlayer(storage.sql, { userId: 'e', username: 'e', slotExpiresAt: null, now: NOW }),
      ).toBeNull();

      deletePlayer(storage.sql, 'b');
      seat(storage, 'f');
      expect(listPlayers(storage.sql).map((player) => [player.user_id, player.slot])).toEqual([
        ['a', 0],
        ['f', 1],
        ['c', 2],
        ['d', 3],
      ]);
    } finally {
      storage.close();
    }
  });

  it('只有从未真正连接的预留座位被释放', () => {
    const storage = withRoom();
    try {
      seat(storage, 'a');
      seat(storage, 'b');
      updatePlayer(storage.sql, 'b', { seated: 1 });
      deleteReservedSeats(storage.sql);
      expect(listPlayers(storage.sql).map((player) => player.user_id)).toEqual(['b']);
    } finally {
      storage.close();
    }
  });

  it('回到大厅时只有未连接的座位被武装过期时间', () => {
    const storage = withRoom();
    try {
      for (const id of ['a', 'b', 'c']) seat(storage, id);
      armLobbySeatExpiry(storage.sql, ['b'], NOW + 5_000);
      expect(getPlayer(storage.sql, 'b')!.slot_expires_at).toBeNull();
      expect(getPlayer(storage.sql, 'a')!.slot_expires_at).toBe(NOW + 5_000);
      expect(getPlayer(storage.sql, 'c')!.slot_expires_at).toBe(NOW + 5_000);

      armLobbySeatExpiry(storage.sql, [], NOW + 9_000);
      expect(listPlayers(storage.sql).map((player) => player.slot_expires_at)).toEqual([
        NOW + 9_000,
        NOW + 9_000,
        NOW + 9_000,
      ]);
    } finally {
      storage.close();
    }
  });

  it('过期座位按时间释放，未设过期时间的座位保留', () => {
    const storage = withRoom();
    try {
      seat(storage, 'expired', NOW - 1);
      seat(storage, 'later', NOW + 1_000);
      seat(storage, 'connected', null);
      expect(expireSeats(storage.sql, NOW)).toBe(1);
      expect(listPlayers(storage.sql).map((player) => player.user_id)).toEqual([
        'later',
        'connected',
      ]);
    } finally {
      storage.close();
    }
  });

  it('开新一局会把座位恢复为满血、第一篇与空草稿', () => {
    const storage = withRoom();
    try {
      seat(storage, 'a');
      updatePlayer(storage.sql, 'a', {
        progress: 7,
        spell_index: 3,
        spells_cast: 3,
        hp: 120,
        damage_dealt: 900,
        correct_chars: 88,
        attempt_total: 40,
        error_total: 5,
        cpm: 210,
        last_input: '霜月幽炎',
        eliminated_at: NOW,
        ready: 1,
      });
      resetPlayersForMatch(storage.sql);
      expect(getPlayer(storage.sql, 'a')).toMatchObject({
        progress: 0,
        spell_index: 0,
        spells_cast: 0,
        hp: INITIAL_HEALTH,
        max_hp: INITIAL_HEALTH,
        damage_dealt: 0,
        correct_chars: 0,
        attempt_total: 0,
        error_total: 0,
        cpm: 0,
        last_input: '',
        eliminated_at: null,
        ready: 1,
      });
      expect(countPlayers(storage.sql)).toBe(1);
    } finally {
      storage.close();
    }
  });
});

describe('列白名单', () => {
  it('固定列与未知字段都改不动，房间行与座位行都不会被注入', () => {
    const storage = withRoom();
    try {
      seat(storage, 'a');
      updateRoom(storage.sql, { id: 'hacked', created_at: 1, phase: 'playing' } as never);
      updatePlayer(storage.sql, 'a', {
        user_id: 'hacked',
        username: 'hacked',
        hp: 5,
        not_a_column: 1,
      } as never);

      const room = getRoom(storage.sql)!;
      expect(room.id).toBe(ROOM_ID);
      expect(room.created_at).toBe(NOW);
      expect(room.phase).toBe('playing');
      const player = getPlayer(storage.sql, 'a')!;
      expect(player.user_id).toBe('a');
      expect(player.username).toBe('a');
      expect(player.hp).toBe(5);
      expect(() => updateRoom(storage.sql, { not_a_column: 'x' } as never)).not.toThrow();
    } finally {
      storage.close();
    }
  });
});

describe('事件环', () => {
  it('按容量截断，保留最新的伤害事件并推进最新序号', () => {
    const storage = withRoom();
    try {
      for (let seq = 1; seq <= COMBAT_EVENT_RING_SIZE + 8; seq += 1)
        appendEvent(storage.sql, event(seq));
      const events = readEvents(getRoom(storage.sql)!);
      expect(events).toHaveLength(COMBAT_EVENT_RING_SIZE);
      expect(events[0].seq).toBe(9);
      expect(events.at(-1)!.seq).toBe(COMBAT_EVENT_RING_SIZE + 8);
      expect(getRoom(storage.sql)!.event_seq).toBe(COMBAT_EVENT_RING_SIZE + 8);
    } finally {
      storage.close();
    }
  });

  it('损坏或非数组的事件环读成空，而不是让房间读状态时崩掉', () => {
    const storage = withRoom();
    try {
      updateRoom(storage.sql, { events_json: '{oops' });
      expect(readEvents(getRoom(storage.sql)!)).toEqual([]);
      updateRoom(storage.sql, { events_json: '"咒文"' });
      expect(readEvents(getRoom(storage.sql)!)).toEqual([]);
    } finally {
      storage.close();
    }
  });
});

describe('结果队列', () => {
  it('按 (match_id, user_id) 幂等，未同步的行按写入顺序排队，标记后不再重试', () => {
    const storage = withRoom();
    try {
      queueResults(storage.sql, [{ ...resultRow('m2'), created_at: NOW + 2 }, resultRow('m1')]);
      queueResults(storage.sql, [{ ...resultRow('m1'), damage_dealt: 999 }]);

      const pending = listUnsavedResults(storage.sql);
      expect(pending.map((row) => row.match_id)).toEqual(['m1', 'm2']);
      expect(pending[0].damage_dealt).toBe(100);
      expect(countUnsavedResults(storage.sql)).toBe(2);

      markResultsSaved(storage.sql, [pending[0]]);
      expect(listUnsavedResults(storage.sql).map((row) => row.match_id)).toEqual(['m2']);
      expect(
        storage.sql
          .exec<{ total: number }>(
            "SELECT COUNT(*) AS total FROM match_results WHERE match_id = 'm1' AND saved = 1",
          )
          .one().total,
      ).toBe(1);
    } finally {
      storage.close();
    }
  });
});

describe('离场记录', () => {
  it('按局判定弃赛：空局号与旧局号都不拦人，且一账户只有一行', () => {
    const storage = withRoom();
    try {
      // 开赛前的离场只是幂等标记，从不拦截重新加入。
      recordDeparture(storage.sql, { userId: 'a', matchId: null, now: NOW });
      expect(getDeparture(storage.sql, 'a')).toMatchObject({
        user_id: 'a',
        match_id: null,
        departed_at: NOW,
      });
      expect(abandonedMatch(storage.sql, 'a', 'm1')).toBe(false);

      recordDeparture(storage.sql, { userId: 'a', matchId: 'm1', now: NOW + 1 });
      expect(abandonedMatch(storage.sql, 'a', 'm1')).toBe(true);
      expect(abandonedMatch(storage.sql, 'a', 'm2')).toBe(false);
      expect(abandonedMatch(storage.sql, 'a', null)).toBe(false);
      expect(abandonedMatch(storage.sql, 'b', 'm1')).toBe(false);

      // 更晚一局的弃赛覆盖旧行：旧局号的记录随之失效。
      recordDeparture(storage.sql, { userId: 'a', matchId: 'm2', now: NOW + 2 });
      expect(abandonedMatch(storage.sql, 'a', 'm1')).toBe(false);
      expect(getDeparture(storage.sql, 'a')).toMatchObject({
        match_id: 'm2',
        departed_at: NOW + 2,
      });
    } finally {
      storage.close();
    }
  });

  it('重复建表不丢弃已存在的离场记录', () => {
    const storage = withRoom();
    try {
      recordDeparture(storage.sql, { userId: 'a', matchId: 'm1', now: NOW });
      createSchema(storage.sql);
      expect(abandonedMatch(storage.sql, 'a', 'm1')).toBe(true);
      expect(getRoom(storage.sql)?.id).toBe(ROOM_ID);
    } finally {
      storage.close();
    }
  });
});
