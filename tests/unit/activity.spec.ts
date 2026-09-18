/**
 * Public activity counters — the homepage's `GET /api/activity`.
 *
 * Pinned here are the lifecycle boundaries a wrong counter would get visibly wrong: which room
 * phases count as an ongoing duel (and the deadline the alarm has not caught up with yet), which
 * queue rows still mean a waiting player once entries expire or pair off, and the route's honesty
 * contract — an aggregate of the shards' real answers, an honest zero only when everything truly is
 * idle, and a 503 rather than a fabricated total when any probe fails. Room and queue counting run
 * against real SQLite through `tests/support/sql-storage.ts`; the route runs against the real Hono
 * app with stub bindings, since the numbers' origins are the unit specs' own subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { registerDuel } from '../../worker/activity';
import app from '../../worker/http/app';
import type { Env } from '../../worker/env';
import { MATCH_DURATION_MS, QUEUE_ENTRY_TTL_MS } from '../../shared/protocol';
import { QueueShard } from '../../worker/matchmaking/queue';
import { createSchema as createQueueSchema } from '../../worker/matchmaking/schema';
import { duelIsOngoing } from '../../worker/rooms/rules';
import { getRoom, insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema as createRoomSchema } from '../../worker/rooms/storage/schema';
import { openTestStorage, type TestStorage } from '../support/sql-storage';

const ROOM_ID = 'a'.repeat(24);
const NOW = 1_700_000_000_000;
const ORIGIN = 'https://app.example';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** An empty room database with the current layout and one lobby room in it. */
function withRoom(): TestStorage {
  const storage = openTestStorage();
  createRoomSchema(storage.sql);
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

describe('进行中的对决判定', () => {
  it('只有战斗阶段且截止时间未到才算进行中', () => {
    const storage = withRoom();
    try {
      updateRoom(storage.sql, { phase: 'playing', deadline: NOW + 1000 });
      expect(duelIsOngoing(getRoom(storage.sql)!, NOW)).toBe(true);
    } finally {
      storage.close();
    }
  });

  it('截止时间一过就不算——即使闹钟还没来得及收尾', () => {
    const storage = withRoom();
    try {
      updateRoom(storage.sql, { phase: 'playing', deadline: NOW + 1000 });
      expect(duelIsOngoing(getRoom(storage.sql)!, NOW + 1000)).toBe(false);
      expect(duelIsOngoing(getRoom(storage.sql)!, NOW + 1001)).toBe(false);
    } finally {
      storage.close();
    }
  });

  it('大厅、出题、倒数与已结算的房间都不算', () => {
    const storage = withRoom();
    try {
      for (const phase of ['lobby', 'generating', 'countdown', 'finished'] as const) {
        updateRoom(storage.sql, { phase, deadline: NOW + MATCH_DURATION_MS });
        expect(duelIsOngoing(getRoom(storage.sql)!, NOW), phase).toBe(false);
      }
    } finally {
      storage.close();
    }
  });
});

describe('等待玩家计数', () => {
  /** An empty queue database plus the shard over it; the caller closes the returned storage. */
  function shardWith(rows: { userId: string; expiresAt: number }[]) {
    const storage = openTestStorage();
    createQueueSchema(storage.sql);
    for (const row of rows) {
      storage.sql.exec(
        'INSERT INTO waiting (user_id, username, request_id, difficulty, enqueued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        row.userId,
        row.userId,
        `req-${row.userId}`,
        'hard',
        NOW,
        row.expiresAt,
      );
    }
    const shard = new QueueShard({
      env: {} as Env,
      storage: {} as DurableObjectStorage,
      sql: storage.sql,
    });
    return { shard, close: () => storage.close() };
  }

  it('过期的等待行不算——不依赖懒清扫是否跑过', async () => {
    const { shard, close } = shardWith([
      { userId: 'a', expiresAt: NOW + QUEUE_ENTRY_TTL_MS },
      { userId: 'b', expiresAt: NOW - 1 },
    ]);
    try {
      await expect(shard.waitingCount()).resolves.toBe(1);
    } finally {
      close();
    }
  });
});

/** The actual discovery SQL runs against SQLite, including the shipped index migration. */
function activityDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE room_sessions (session_hash TEXT, room_id TEXT)');
  db.exec(
    readFileSync(new URL('../../migrations/0002_room_activity.sql', import.meta.url), 'utf8'),
  );
  function statement(sql: string, values: (string | number)[] = []) {
    return {
      bind: (...params: (string | number)[]) => statement(sql, params),
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => db.prepare(sql).run(...values),
    };
  }
  return {
    db,
    binding: {
      prepare: statement,
      batch: async (statements: { run(): Promise<unknown> }[]) =>
        Promise.all(statements.map((query) => query.run())),
    },
  };
}

/** ROOMS binding stand-in: each room answers `activeDuel()` out of "its own state". */
function roomsBinding(answers: Record<string, boolean | Error>) {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      activeDuel: async () => {
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
  };
}

/** MATCHMAKER binding stand-in: queue shards answer `waitingCount()`. */
function matchmakerBinding(waiting: Record<string, number | Error>) {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      waitingCount: async () => {
        const count = waiting[name];
        if (count instanceof Error) throw count;
        return count;
      },
    }),
  };
}

describe('GET /api/activity', () => {
  it('断线对局仍可发现，同一房间的多个会话不重复计数，索引按截止时间失效', async () => {
    const { db, binding } = activityDb();
    const env = {
      DB: binding,
      ROOMS: roomsBinding({ connected: true, disconnected: true, expired: true, finished: false }),
      MATCHMAKER: matchmakerBinding({ 'q:hard': 0 }),
    } as unknown as Env;
    try {
      db.exec("INSERT INTO room_sessions VALUES ('s1', 'connected'), ('s2', 'connected')");
      await registerDuel(env, 'connected', NOW + 2000);
      await registerDuel(env, 'disconnected', NOW + 2000);
      await registerDuel(env, 'finished', NOW + 2000);
      await registerDuel(env, 'expired', NOW);
      const response = await app.request(`${ORIGIN}/api/activity`, {}, env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ activeDuels: 2, waitingPlayers: 0 });
      // No sockets left, and a stale registration must not shorten the current match's lease.
      db.exec('DELETE FROM room_sessions');
      await registerDuel(env, 'disconnected', NOW + 1000);
      vi.setSystemTime(NOW + 1500);
      await expect((await app.request(`${ORIGIN}/api/activity`, {}, env)).json()).resolves.toEqual({
        activeDuels: 2,
        waitingPlayers: 0,
      });
      vi.setSystemTime(NOW + 2000);
      await expect((await app.request(`${ORIGIN}/api/activity`, {}, env)).json()).resolves.toEqual({
        activeDuels: 0,
        waitingPlayers: 0,
      });
    } finally {
      db.close();
    }
  });

  it('任一探测失败就整体 503，绝不把探测不到的房间当成空闲', async () => {
    const { db, binding } = activityDb();
    try {
      db.exec("INSERT INTO room_sessions VALUES ('s1', 'r1'), ('s2', 'r2')");
      const deadRoom = {
        DB: binding,
        ROOMS: roomsBinding({ r1: true, r2: new Error('room unreachable') }),
        MATCHMAKER: matchmakerBinding({ 'q:hard': 0 }),
      } as unknown as Env;
      const roomFailure = await app.request(`${ORIGIN}/api/activity`, {}, deadRoom);
      expect(roomFailure.status).toBe(503);
      await expect(roomFailure.json()).resolves.toHaveProperty('error');
      const deadQueue = {
        DB: binding,
        ROOMS: roomsBinding({ r1: false, r2: false }),
        MATCHMAKER: matchmakerBinding({ 'q:hard': new Error('shard unreachable') }),
      } as unknown as Env;
      expect((await app.request(`${ORIGIN}/api/activity`, {}, deadQueue)).status).toBe(503);
    } finally {
      db.close();
    }
  });
});
