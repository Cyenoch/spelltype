/**
 * Public activity counters — the homepage's `GET /api/activity`.
 *
 * Pinned here are the lifecycle boundaries a wrong counter would get visibly wrong: which room
 * phases count as an ongoing duel (the clock decides, never the alarm), which ticket rows still
 * mean a waiting player once entries expire or pair off, and the route's honesty contract — an
 * honest zero only when everything truly is idle, and a 503 rather than a fabricated total when
 * the read fails. Everything runs against a real PGlite database and the real stable app.
 */
import { describe, expect, it } from 'bun:test';
import { DEV_RELEASE_ID } from '../../shared/release';
import { readActivitySummary } from '../../server/activity';
import type { ServerConfig } from '../../server/config';
import type { Database } from '../../server/db';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import {
  accounts,
  departures,
  matchTickets,
  players,
  releaseControl,
  releaseVersions,
  results,
  roomSessions,
  rooms,
  sessions,
} from '../../server/db/schema';
import { createStableApp } from '../../server/http/app';

const ORIGIN = 'https://app.example';
const RELEASE = DEV_RELEASE_ID;
const NOW = Date.now();

let database: OpenedDatabase;

/** Foreign keys decide the order; every table starts empty so each test sees one clean state. */
async function wipeEverything(db: Database): Promise<void> {
  await db.delete(matchTickets);
  await db.delete(departures);
  await db.delete(results);
  await db.delete(roomSessions);
  await db.delete(players);
  await db.delete(rooms);
  await db.delete(sessions);
  await db.delete(accounts);
  await db.delete(releaseControl);
  await db.delete(releaseVersions);
}

async function setup(): Promise<void> {
  database ??= await openDatabase('pglite://:memory:');
  await wipeEverything(database.db);
  await database.db.insert(releaseVersions).values({
    id: RELEASE,
    state: 'active',
    artifact_digest: 'a'.repeat(64),
    operation_id: '00000000-0000-0000-0000-000000000000',
    created_at: NOW,
    updated_at: NOW,
  });
  await database.db
    .insert(releaseControl)
    .values({ singleton: 1, active_release_id: RELEASE, revision: 0, updated_at: NOW });
  await database.db.insert(accounts).values({
    id: '000000000000000000000000',
    username: '等待者',
    username_key: '等待者',
    password_hash: '$argon2id$v=19$m=19456,t=2,p=1$' + 'a'.repeat(22) + '$' + 'b'.repeat(43),
    created_at: NOW,
  });
}

/** Inserts a room whose duel-liveness is decided purely by the seeded phase and deadline. */
async function seedRoom(
  roomId: string,
  phase: 'lobby' | 'generating' | 'countdown' | 'playing' | 'finished',
  deadline: number,
): Promise<void> {
  await database.db.insert(rooms).values({
    id: roomId,
    release_id: RELEASE,
    host_id: '000000000000000000000000',
    mode: 'quick',
    theme: '主题',
    difficulty: 'hard',
    phase,
    deadline,
    created_at: NOW,
    updated_at: NOW,
  });
}

/** Inserts a queue ticket for a fresh account; `state` separates waiting from seated matched. */
async function seedTicket(
  requestId: string,
  state: 'waiting' | 'matched',
  expiresAt: number,
): Promise<void> {
  const userId = requestId.replace(/-/g, '').padEnd(24, '0').slice(0, 24);
  await database.db.insert(accounts).values({
    id: userId,
    username: requestId,
    username_key: requestId,
    password_hash: '$argon2id$v=19$m=19456,t=2,p=1$' + 'a'.repeat(22) + '$' + 'b'.repeat(43),
    created_at: NOW,
  });
  await database.db.insert(matchTickets).values({
    user_id: userId,
    request_id: requestId,
    release_id: RELEASE,
    username: requestId,
    state,
    expires_at: expiresAt,
    created_at: NOW,
    updated_at: NOW,
  });
}

function testApp(databaseHandle: Database) {
  const config: ServerConfig = {
    role: 'all',
    releaseId: RELEASE,
    databaseUrl: 'pglite://:memory:',
    hostname: '127.0.0.1',
    port: 0,
    adminPort: null,
    publicOrigin: ORIGIN,
    adminToken: null,
    assetsRoot: null,
    ai: { apiKey: null, model: 'test-model' },
    authLimits: { attempts: 100, windowMs: 60_000 },
    trustForwardedFor: false,
    matchAdmission: 'open',
    inputPolicyMode: 'observe',
  };
  return createStableApp({ database: databaseHandle, config, rooms: null });
}

describe('进行中的对决判定', () => {
  it('只有战斗进行中且截止时刻未到的房间算作一场对决', async () => {
    await setup();
    const id = (index: number) => index.toString(16).padStart(24, '0');
    await seedRoom(id(1), 'playing', NOW + 1000); // 活着的战斗
    await seedRoom(id(2), 'playing', NOW); // 时钟已到，闹钟未追上：不算
    await seedRoom(id(3), 'playing', NOW - 1000); // 已超时：不算
    await seedRoom(id(4), 'countdown', NOW + 1000); // 开场倒计时：不算
    await seedRoom(id(5), 'generating', 0); // 出题中：不算
    await seedRoom(id(6), 'lobby', 0); // 大厅：不算
    await seedRoom(id(7), 'finished', 0); // 已结束：不算
    expect(await readActivitySummary(database.db)).toEqual({
      activeDuels: 1,
      waitingPlayers: 0,
    });
  });
});

describe('等待玩家计数', () => {
  it('只有未过期且未配对的队列条目算作等待玩家', async () => {
    await setup();
    // matched 持有的是席位，不是队列位置；同一张票无法同时等待，过期条目说明已离开。
    await seedTicket('request-waiting', 'waiting', NOW + 1000);
    await seedTicket('request-expired', 'matched', NOW - 1000);
    expect(await readActivitySummary(database.db)).toEqual({
      activeDuels: 0,
      waitingPlayers: 1,
    });
  });
});

describe('GET /api/activity', () => {
  it('空闲时是诚实的零，响应不被缓存', async () => {
    await setup();
    const app = testApp(database.db);
    const response = await app.request(`${ORIGIN}/api/activity`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ activeDuels: 0, waitingPlayers: 0 });
  });

  it('汇总真实状态：进行中的对决与等待的玩家', async () => {
    await setup();
    await seedRoom('a'.repeat(24), 'playing', NOW + 5000);
    await seedTicket('request-live', 'waiting', NOW + 5000);
    const app = testApp(database.db);
    const response = await app.request(`${ORIGIN}/api/activity`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeDuels: 1, waitingPlayers: 1 });
  });

  it('读取失败是 503，而不是把失败伪装成空闲', async () => {
    await setup();
    const failingDatabase = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === 'select') throw new Error('db down: SELECT secret');
        return Reflect.get(target, property, receiver);
      },
    });
    const app = testApp(failingDatabase);
    const response = await app.request(`${ORIGIN}/api/activity`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: '活动数据暂时不可用，请稍后再试。' });
  });
});
