/**
 * Room state-layer unit tests — the Durable Object's own SQL, against a real SQLite engine.
 *
 * Kept to the state transitions that lose, duplicate or leak player data when they are wrong: opening
 * the schema, seat allocation/expiry, the bounded event ring, the per-match reset and the results
 * queue's idempotency key. `tests/support/sql-storage.ts` gives `node:sqlite` the workerd `SqlStorage`
 * surface, so these run in milliseconds instead of through a booted room.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMBAT_EVENT_RING_SIZE, INITIAL_HEALTH, type CombatEvent } from '../../shared/protocol';
import { appendEvents, readEvents } from '../../worker/rooms/storage/events';
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
import { INPUT_POLICY_VERSION } from '../../worker/rooms/rules';
import { createSchema } from '../../worker/rooms/storage/schema';
import { openTestStorage, type TestStorage } from '../support/sql-storage';
import type { SqlStore } from '../../worker/sql';

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
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'enforce' as const,
    input_gate_hits: 2,
    input_recoveries: 1,
    input_overloads: 0,
    input_recovered_completions: 1,
    input_recovery_departures: 0,
    input_min_completion_ratio: 0.25,
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

  it('开新一局会把座位恢复为满血、第一篇与空草稿，并清空输入资格与本局摘要', () => {
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
        input_opened_at: NOW,
        input_not_before: NOW + 1_750,
        draft_epoch: 4,
        input_reset_reason: 'completion_too_early',
        input_sampled: 1,
        input_gate_hits: 3,
        input_recoveries: 2,
        input_min_completion_ratio: 0.5,
        input_overloads: 1,
        input_recovered_completions: 1,
        input_recovery_departures: 1,
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
        input_opened_at: null,
        input_not_before: null,
        draft_epoch: 0,
        input_reset_reason: null,
        input_sampled: 0,
        input_gate_hits: 0,
        input_recoveries: 0,
        input_min_completion_ratio: null,
        input_overloads: 0,
        input_recovered_completions: 0,
        input_recovery_departures: 0,
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
        appendEvents(storage.sql, [event(seq)]);
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

/** Frozen pre-policy layout: migration tests must not derive their baseline from current DDL. */
function legacyRoom(phase: 'finished' | 'generating' | 'countdown' | 'playing'): TestStorage {
  const storage = openTestStorage();
  storage.sql.exec(`CREATE TABLE room (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, host_id TEXT NOT NULL,
    mode TEXT NOT NULL, theme TEXT NOT NULL, difficulty TEXT NOT NULL, phase TEXT NOT NULL,
    deadline INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER, end_reason TEXT,
    match_id TEXT, spell_book TEXT, events_json TEXT NOT NULL DEFAULT '[]', event_seq INTEGER NOT NULL DEFAULT 0,
    error TEXT, generation_token TEXT, generation_claim TEXT, generation_seq INTEGER NOT NULL DEFAULT 0,
    reservation_state TEXT NOT NULL DEFAULT 'none', reservation_expires_at INTEGER,
    locked INTEGER NOT NULL DEFAULT 0, persistence TEXT NOT NULL DEFAULT 'idle',
    persist_attempts INTEGER NOT NULL DEFAULT 0, persist_retry_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  storage.sql.exec(`CREATE TABLE players (
    user_id TEXT PRIMARY KEY, username TEXT NOT NULL, slot INTEGER NOT NULL, joined_at INTEGER NOT NULL,
    slot_expires_at INTEGER, conn_id TEXT, seated INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0, spell_index INTEGER NOT NULL DEFAULT 0,
    spells_cast INTEGER NOT NULL DEFAULT 0, hp INTEGER NOT NULL DEFAULT 2400, max_hp INTEGER NOT NULL DEFAULT 2400,
    damage_dealt INTEGER NOT NULL DEFAULT 0, correct_chars INTEGER NOT NULL DEFAULT 0,
    attempt_total INTEGER NOT NULL DEFAULT 0, error_total INTEGER NOT NULL DEFAULT 0,
    cpm INTEGER NOT NULL DEFAULT 0, last_input TEXT NOT NULL DEFAULT '', eliminated_at INTEGER)`);
  storage.sql.exec(`CREATE TABLE match_results (
    match_id TEXT NOT NULL, user_id TEXT NOT NULL, theme TEXT NOT NULL,
    damage_dealt INTEGER NOT NULL, hp_remaining INTEGER NOT NULL, spells_cast INTEGER NOT NULL,
    correct_chars INTEGER NOT NULL, duration_ms INTEGER NOT NULL, rank INTEGER NOT NULL,
    cpm INTEGER NOT NULL, accuracy REAL, created_at INTEGER NOT NULL,
    saved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (match_id, user_id))`);
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: 'host-1',
    mode: 'private',
    theme: '旧局',
    difficulty: 'hard',
    reservationState: 'none',
    reservationExpiresAt: null,
    now: NOW,
  });
  seat(storage, 'host-1');
  updateRoom(storage.sql, { phase, match_id: 'legacy-match', deadline: NOW - 1 });
  updatePlayer(storage.sql, 'host-1', {
    last_input: 'accepted',
    attempt_total: 12,
    error_total: 3,
    hp: 1234,
  });
  storage.sql.exec(
    `INSERT INTO match_results
    (match_id,user_id,theme,damage_dealt,hp_remaining,spells_cast,correct_chars,duration_ms,rank,cpm,accuracy,created_at)
    VALUES ('legacy-match','host-1','旧局',1166,1234,3,150,30000,1,300,0.75,?)`,
    NOW,
  );
  return storage;
}

describe('输入规则升级', () => {
  it('旧终局与待保存结果升级两次仍可重试，不伪造测量零值', () => {
    const storage = legacyRoom('finished');
    try {
      storage.transactionSync(() => createSchema(storage.sql));
      storage.transactionSync(() => createSchema(storage.sql));
      expect(getPlayer(storage.sql, 'host-1')).toMatchObject({
        last_input: 'accepted',
        attempt_total: 12,
        error_total: 3,
        hp: 1234,
      });
      const rows = listUnsavedResults(storage.sql);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        match_id: 'legacy-match',
        damage_dealt: 1166,
        input_policy_version: 'legacy-unmeasured',
        input_policy_mode: null,
        input_gate_hits: null,
        input_recoveries: null,
        input_overloads: null,
        input_min_completion_ratio: null,
        input_recovered_completions: null,
        input_recovery_departures: null,
      });
      queueResults(storage.sql, rows);
      expect(listUnsavedResults(storage.sql)).toEqual(rows);
      markResultsSaved(storage.sql, rows);
      expect(listUnsavedResults(storage.sql)).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it.each(['generating', 'countdown', 'playing'] as const)(
    '旧 %s 局即使截止已过也拒绝启用，回滚所有DDL',
    (phase) => {
      const storage = legacyRoom(phase);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const before = storage.sql
          .exec('SELECT name,sql FROM sqlite_master ORDER BY name')
          .toArray();
        const players = listPlayers(storage.sql);
        expect(() => storage.transactionSync(() => createSchema(storage.sql))).toThrow(
          'input_policy_drain_required',
        );
        expect(
          storage.sql.exec('SELECT name,sql FROM sqlite_master ORDER BY name').toArray(),
        ).toEqual(before);
        expect(listPlayers(storage.sql)).toEqual(players);
        expect(getRoom(storage.sql)?.phase).toBe(phase);
        expect(storage.sql.exec('SELECT damage_dealt FROM match_results').one().damage_dealt).toBe(
          1166,
        );
      } finally {
        log.mockRestore();
        storage.close();
      }
    },
  );

  it('中途ALTER失败回滚结构和旧数据；排除故障后仍可完整升级', () => {
    const storage = legacyRoom('finished');
    try {
      const before = storage.sql.exec('SELECT name,sql FROM sqlite_master ORDER BY name').toArray();
      let alters = 0;
      const broken: SqlStore = {
        exec(query, ...bindings) {
          if (query.startsWith('ALTER TABLE') && ++alters === 5)
            throw new Error('injected ALTER failure');
          return storage.sql.exec(query, ...bindings);
        },
      };
      expect(() => storage.transactionSync(() => createSchema(broken))).toThrow(
        'injected ALTER failure',
      );
      expect(
        storage.sql.exec('SELECT name,sql FROM sqlite_master ORDER BY name').toArray(),
      ).toEqual(before);
      storage.transactionSync(() => createSchema(storage.sql));
      expect(listUnsavedResults(storage.sql)[0]).toMatchObject({
        match_id: 'legacy-match',
        damage_dealt: 1166,
        input_gate_hits: null,
      });
    } finally {
      storage.close();
    }
  });

  it('新局改变策略不改变已入队摘要；重试不能覆盖首次测量', () => {
    const storage = withRoom();
    try {
      const result = resultRow('measured');
      queueResults(storage.sql, [result]);
      updateRoom(storage.sql, {
        match_id: 'another',
        input_policy_version: 'next-version',
        input_policy_mode: 'observe',
        input_min_ms_per_code_point: 20,
      });
      resetPlayersForMatch(storage.sql);
      queueResults(storage.sql, [{ ...result, input_policy_mode: 'observe', input_gate_hits: 0 }]);
      expect(listUnsavedResults(storage.sql)).toEqual([{ ...result, saved: 0 }]);
    } finally {
      storage.close();
    }
  });
});
