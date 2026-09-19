/**
 * Request input boundaries — the gates every state change, WebSocket handshake and JSON body
 * passes through.
 *
 * Every case is driven through the real app (`createApp` in `server/http/app.ts`) over a real
 * PGlite database, so what is pinned is the behaviour of the boundary itself: the same-origin
 * gate on state changes and WebSocket handshakes, the body cap (which must cut an oversized
 * stream, not buffer it), the narrowing of untrusted request values, the wire-protocol gate on
 * every game request, the maintenance admission rules, native method/route handling (the old
 * release-scoped prefixes no longer exist) and the JSON body contract. A stub `RoomRuntimePort`
 * fails loudly if a gate lets a request through that should never reach the runtime.
 */
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  MAX_API_BODY_BYTES,
  MAX_THEME_CHARS,
  WS_PROTOCOL,
  type RoomSnapshot,
} from '../../shared/protocol';
import type { MaintenanceInfo } from '../../shared/maintenance';
import { themeSchema } from '../../shared/validation';
import { SESSION_COOKIE, createSession } from '../../server/auth/sessions';
import { readServerConfig, type ServerConfig } from '../../server/config';
import type { RoomRuntimePort } from '../../server/contracts';
import type { Database, OpenedDatabase } from '../../server/db';
import { openDatabase } from '../../server/db';
import {
  accounts,
  departures,
  matchTickets,
  players,
  results,
  roomSessions,
  rooms,
  runtimeControl,
  sessions,
} from '../../server/db/schema';
import { createApp } from '../../server/http/app';
import { enterMaintenance } from '../../server/maintenance/control';
import { parsedString, rejected } from '../support/schema-probe';

const ORIGIN = 'https://app.example';
const ROOM_ID = '0123456789abcdef01234567';

const minimalSnapshot = (roomId: string): RoomSnapshot => ({
  id: roomId,
  protocolVersion: WS_PROTOCOL,
  matchId: null,
  hostId: 'host',
  mode: 'private',
  opponentKind: 'human',
  theme: '主题',
  difficulty: 'hard',
  phase: 'lobby',
  deadline: 0,
  serverNow: Date.now(),
  startedAt: null,
  endedAt: null,
  endReason: null,
  spell: null,
  selfInput: '',
  selfInputGate: null,
  selfInputStats: null,
  events: [],
  persistence: 'idle',
  reservationExpiresAt: null,
  players: [],
  error: null,
});

/** The runtime the gates must protect: any call is recorded, never silently tolerated. */
const runtimeLog: string[] = [];
const runtime: RoomRuntimePort = {
  runtimeEpoch: 1,
  assertOwnership: async () => {
    runtimeLog.push('ownership');
  },
  snapshot: async (roomId) => {
    runtimeLog.push(`snapshot:${roomId}`);
    return minimalSnapshot(roomId);
  },
  authorizeSocket: async (roomId) => {
    runtimeLog.push(`authorize:${roomId}`);
  },
  connect: () => runtimeLog.push('connect'),
  message: () => runtimeLog.push('message'),
  disconnect: () => runtimeLog.push('disconnect'),
  leaveRoom: async (roomId, userId) => {
    runtimeLog.push(`leave:${roomId}:${userId}`);
  },
  revokeSession: async (tokenHash) => {
    runtimeLog.push(`revoke:${tokenHash}`);
  },
  refreshRoom: async (roomId) => {
    runtimeLog.push(`refresh:${roomId}`);
  },
  close: async () => {},
};

let database: OpenedDatabase;
let app: ReturnType<typeof createApp>;

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
}

/** A fresh environment per test: every gate sees the same clean database and open control row. */
async function setup(): Promise<void> {
  database ??= await openDatabase('pglite://:memory:');
  await wipeEverything(database.db);
  // The control row outlives table wipes (no owner to cascade from): reset it so every test
  // starts from the fresh-install state — open, revision 0, no runtime lease.
  await database.db.delete(runtimeControl);
  await database.db.insert(runtimeControl).values({
    singleton: 1,
    mode: 'open',
    revision: 0,
    updated_at: Date.now(),
  });
  runtimeLog.length = 0;
  app = createApp({
    database: database.db,
    config: testConfig({ attempts: 1000, windowMs: 60_000 }),
    rooms: runtime,
  });
}

/** A ServerConfig literal for tests, with the auth budget the scenario needs. */
function testConfig(authLimits: { attempts: number; windowMs: number }): ServerConfig {
  return {
    buildId: 'unit-test',
    autoMigrate: false,
    databaseUrl: 'pglite://:memory:',
    hostname: '127.0.0.1',
    port: 0,
    publicOrigin: ORIGIN,
    maintenanceToken: null,
    assetsRoot: null,
    ai: { apiKey: null, model: 'test-model' },
    authLimits,
    trustForwardedFor: false,
    wechatBridge: null,
    inputPolicyMode: 'observe',
  };
}

/** Anything that can serve a request: the real app and the admin app both qualify. */
interface RequestTarget {
  request(input: string, init?: RequestInit, env?: unknown): Response | Promise<Response>;
}

/** Shaped after the real `fetch` request the browser makes. */
async function call(
  target: RequestTarget,
  method: string,
  path: string,
  options: {
    origin?: string | null;
    body?: string | ReadableStream<Uint8Array>;
    headers?: Record<string, string | undefined>;
    env?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  const gamePath = /^\/api\/(rooms|match)\b/.test(new URL(path, ORIGIN).pathname);
  if (gamePath) headers.set('x-spelltype-protocol', WS_PROTOCOL);
  if (path.endsWith('/ws')) headers.set('sec-websocket-protocol', WS_PROTOCOL);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return Promise.resolve(
    target.request(`${ORIGIN}${path}`, { method, headers, body: options.body }, options.env),
  );
}

/**
 * A real session for authenticated requests: the account/session rows the WeChat callback would
 * have committed, and the bearer-shaped cookie value exactly as the browser holds it.
 */
async function sessionCookie(userId = 'session-user-000000000001'): Promise<string> {
  await database.db
    .insert(accounts)
    .values({
      id: userId,
      username: '咒文使',
      wechat_identity: `union:${userId}`,
      created_at: Date.now(),
    })
    .onConflictDoNothing();
  const ticket = await createSession(database.db, userId);
  return ticket.token;
}

/** A session whose account row carries `role`, exactly as a completed login would have left it. */
async function sessionAs(role: 'user' | 'admin', id: string): Promise<string> {
  await database.db
    .insert(accounts)
    .values({
      id,
      username: id,
      wechat_identity: `union:${id}`,
      role,
      created_at: Date.now(),
    })
    .onConflictDoNothing();
  const ticket = await createSession(database.db, id);
  return ticket.token;
}

const GAME_STATE_CHANGES = [
  { method: 'POST', path: '/api/rooms', body: JSON.stringify({ theme: '咒文契约' }) },
  { method: 'POST', path: '/api/match', body: undefined },
  { method: 'DELETE', path: '/api/match', body: undefined },
  { method: 'POST', path: `/api/rooms/${ROOM_ID}/leave`, body: undefined },
  { method: 'GET', path: `/api/rooms/${ROOM_ID}/ws`, body: undefined },
];

describe('同源校验', () => {
  it('稳定端的每一个状态变更都要求规范来源', async () => {
    await setup();
    const hostile = [
      null,
      'null',
      'https://evil.example',
      'http://app.example',
      'https://app.example:8443',
      'https://app.example/',
      'https://app.example?x=1',
      'not a url',
    ];
    for (const { method, path, body } of [
      { method: 'POST', path: '/api/logout', body: undefined },
      ...GAME_STATE_CHANGES,
    ]) {
      for (const origin of hostile) {
        const response = await call(app, method, path, { origin, body });
        expect(response.status, `${method} ${path} origin=${origin}`).toBe(403);
      }
    }
  });

  it('拒绝时返回统一的 JSON 错误体，且不被缓存', async () => {
    await setup();
    const response = await call(app, 'POST', '/api/logout', {
      origin: 'https://evil.example',
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: '请求来源不受信任' });
  });

  it('规范来源能通过该闸门，走到各自的下一个判定', async () => {
    await setup();
    // 无会话的登出没有可吊销的内容：闸门放行后即成功。
    expect(await (await call(app, 'POST', '/api/logout')).json()).toEqual({ ok: true });

    // 带会话的接口到达鉴权：无 Cookie 即 401。
    expect((await call(app, 'POST', '/api/match')).status).toBe(401);
    expect((await call(app, 'POST', `/api/rooms/${ROOM_ID}/leave`)).status).toBe(401);

    // 房间握手到达升级判定：普通 GET 即 426。
    expect((await call(app, 'GET', `/api/rooms/${ROOM_ID}/ws`)).status).toBe(426);
  });
});

describe('房间号', () => {
  it('形状不对的房间号在进入房间流程之前就被拒绝', async () => {
    await setup();
    const token = await sessionCookie();
    for (const path of ['/api/rooms/not-a-room-id', '/api/rooms/not-a-room-id/ws']) {
      const response = await call(app, 'GET', path, {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: '房间不存在' });
    }
    expect(runtimeLog).toEqual([]);
  });
});

describe('请求体上限', () => {
  it('声明超限与流式超限都被截断为 413', async () => {
    await setup();
    const declared = await call(app, 'POST', '/api/rooms', {
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
      headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: '请求内容过大' });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ theme: 'x'.repeat(MAX_API_BODY_BYTES) })),
        );
        controller.close();
      },
    });
    const chunked = await call(app, 'POST', '/api/rooms', { body: stream });
    expect(chunked.status).toBe(413);
    expect(runtimeLog).toEqual([]);
  });

  it('无长度声明的分块请求体在上限内照常解析并交到业务层', async () => {
    await setup();
    const token = await sessionCookie();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ theme: '咒文契约' })));
        controller.close();
      },
    });
    const response = await call(app, 'POST', '/api/rooms', {
      body: stream,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    // 上限内的分块请求体真的被读入并交给建房：这是 200 的房间创建。
    expect(response.status).toBe(200);
  });

  it('恰好等于上限的请求体不被截断，而是照常解析', async () => {
    await setup();
    const token = await sessionCookie();
    const template = JSON.stringify({ theme: '咒文契约', pad: '' });
    const body = JSON.stringify({
      theme: '咒文契约',
      pad: 'x'.repeat(MAX_API_BODY_BYTES - new TextEncoder().encode(template).byteLength),
    });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_API_BODY_BYTES);

    const response = await call(app, 'POST', '/api/rooms', {
      body,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    // 请求体真的被完整读入：恰好上限的合法主题照样建成房间。
    expect(response.status).toBe(200);
    const { roomId } = (await response.json()) as { roomId: string };
    expect(roomId).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('JSON 请求体', () => {
  it('非法 JSON、空体、非对象与错误形状都是 400 且带 JSON 错误体', async () => {
    await setup();
    const token = await sessionCookie();
    const bodies = ['{oops', '', '[]', 'null', '"text"', '{}', '{"theme":""}', '{"theme":42}'];
    for (const body of bodies) {
      const response = await call(app, 'POST', '/api/rooms', {
        body,
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(response.status, body || 'empty').toBe(400);
      const payload = (await response.json()) as { error?: unknown };
      expect(typeof payload.error, body || 'empty').toBe('string');
      expect((payload.error as string).length, body || 'empty').toBeGreaterThan(0);
    }
    expect(runtimeLog).toEqual([]);
  });

  it('非 JSON 的 Content-Type 不能绕过校验', async () => {
    await setup();
    const token = await sessionCookie();
    const response = await call(app, 'POST', '/api/rooms', {
      body: JSON.stringify({ theme: '咒文契约' }),
      headers: { 'content-type': 'text/plain', cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(response.status).toBe(400);
  });

  it('未预期的故障是 500 JSON，不泄露内部信息', async () => {
    await setup();
    const token = await sessionCookie();
    const failingDatabase = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === 'select') throw new Error('db down: SELECT secret');
        return Reflect.get(target, property, receiver);
      },
    });
    const failing = createApp({
      database: failingDatabase,
      config: testConfig({ attempts: 10, windowMs: 60_000 }),
      rooms: null,
    });
    const response = await call(failing, 'GET', '/api/profile', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '服务器内部错误' });
  });
});

describe('方法与路径', () => {
  it('已知路径上不支持的方法返回 405，并声明允许的方法', async () => {
    await setup();
    for (const [method, path, allowed] of [
      ['PUT', '/api/session', ['GET', 'HEAD']],
      ['POST', '/api/session', ['GET', 'HEAD']],
      ['GET', '/api/match', ['POST', 'DELETE']],
      ['DELETE', `/api/rooms/${ROOM_ID}/leave`, ['POST']],
      ['POST', `/api/rooms/${ROOM_ID}/ws`, ['GET', 'HEAD']],
    ] as const) {
      const response = await call(app, method, path);
      expect(response.status, `${method} ${path}`).toBe(405);
      const allow = (response.headers.get('allow') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      expect(allow.sort(), `${method} ${path}`).toEqual(Array.from(allowed).sort());
      expect(await response.json()).toEqual({ error: '请求方法不被支持' });
    }
  });

  it('未知接口是 404；发布前缀与旧定位端点不复存在', async () => {
    await setup();
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await call(app, method, '/api/unknown');
      expect(response.status, method).toBe(404);
      expect(await response.json()).toEqual({ error: '接口不存在' });
    }
    // 旧的发布前缀（以及它下面的房间/对局路径）已删除：整套 API 只有一个稳定根。
    for (const path of [
      `/api/releases/${'a'.repeat(32)}/rooms`,
      `/api/rooms/${ROOM_ID}/location`,
      '/api/release',
    ]) {
      const response = await call(app, 'GET', path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: '接口不存在' });
    }
  });
});

describe('请求取值', () => {
  it('主题裁剪空白并按码点限制长度', () => {
    expect(parsedString(themeSchema, '  星陨图书馆  ')).toBe('星陨图书馆');
    // 长度按码点计数：一个 emoji 也是一个字符。
    expect(Array.from(parsedString(themeSchema, '🌸'.repeat(MAX_THEME_CHARS))!).length).toBe(
      MAX_THEME_CHARS,
    );
    for (const value of ['', '   ', '咒'.repeat(MAX_THEME_CHARS + 1), 42, null]) {
      expect(rejected(themeSchema, value), String(value)).toBe(true);
    }
  });
});

describe('协议准入', () => {
  it('缺少、为空或过期的协议头都不能建房、入队或取消', async () => {
    await setup();
    const token = await sessionCookie();
    for (const header of [undefined, '', 'spelltype.v1', 'spelltype.v9']) {
      const headers: Record<string, string | undefined> = {
        cookie: `${SESSION_COOKIE}=${token}`,
      };
      headers['x-spelltype-protocol'] = header;
      const created = await call(app, 'POST', '/api/rooms', {
        body: JSON.stringify({ theme: '咒文契约' }),
        headers,
      });
      expect(created.status, `header=${header}`).toBe(409);
      expect(await created.json()).toMatchObject({
        code: 'protocol:mismatch',
        protocolVersion: WS_PROTOCOL,
      });
      expect((await call(app, 'POST', '/api/match', { headers })).status).toBe(409);
      expect((await call(app, 'DELETE', '/api/match', { headers })).status).toBe(409);
      expect((await call(app, 'GET', `/api/rooms/${ROOM_ID}`, { headers })).status).toBe(409);
    }
    // 没有任何请求到达运行时。
    expect(runtimeLog).toEqual([]);
  });

  it('当前协议的建房被准入：房间落库、运行时接手，快照可读、离场可用', async () => {
    await setup();
    const token = await sessionCookie();
    const created = await call(app, 'POST', '/api/rooms', {
      body: JSON.stringify({ theme: '咒文契约' }),
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(created.status).toBe(200);
    const { roomId } = (await created.json()) as { roomId: string };
    expect(roomId).toMatch(/^[0-9a-f]{24}$/);
    expect(runtimeLog).toContain(`refresh:${roomId}`);

    const seeded = await database.db.select().from(rooms);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.id).toBe(roomId);
    expect(seeded[0]?.host_id).toBeDefined();

    const snapshot = await call(app, 'GET', `/api/rooms/${roomId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ id: roomId, protocolVersion: WS_PROTOCOL });

    const left = await call(app, 'POST', `/api/rooms/${roomId}/leave`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(left.status).toBe(200);
    expect(await left.json()).toEqual({ left: true });
    expect(runtimeLog).toContain(`leave:${roomId}:${'session-user-000000000001'}`);
  });

  it('WebSocket 握手以子协议核验协议：缺失或过期都被拒之门外', async () => {
    await setup();
    const token = await sessionCookie();
    await database.db.insert(rooms).values({
      id: ROOM_ID,
      host_id: 'host',
      mode: 'private',
      theme: '主题',
      difficulty: 'hard',
      phase: 'lobby',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    for (const protocol of [undefined, '', 'spelltype.v1']) {
      const response = await call(app, 'GET', `/api/rooms/${ROOM_ID}/ws`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          upgrade: 'websocket',
          'sec-websocket-protocol': protocol,
        },
      });
      expect(response.status, `protocol=${protocol}`).toBe(426);
      expect(await response.json()).toMatchObject({
        code: 'protocol:mismatch',
        protocolVersion: WS_PROTOCOL,
      });
    }
    expect(runtimeLog).toEqual([]);
  });

  it('授权通过后以 roomId 和会话升级连接，升级失败是明确的 426', async () => {
    await setup();
    const token = await sessionCookie();
    await database.db.insert(rooms).values({
      id: ROOM_ID,
      host_id: 'host',
      mode: 'private',
      theme: '主题',
      difficulty: 'hard',
      phase: 'lobby',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    let upgradedWith: { roomId: string; session: unknown } | undefined;
    const makeServer = (accept: boolean) => ({
      upgrade: (_request: Request, options: { data: { roomId: string; session: unknown } }) => {
        upgradedWith = options.data;
        return accept;
      },
    });
    const rejected = await call(app, 'GET', `/api/rooms/${ROOM_ID}/ws`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, upgrade: 'websocket' },
      env: { server: makeServer(false) },
    });
    // 升级被底层拒绝时，客户端拿到的是明确的 426，而不是半个 socket。
    expect(rejected.status).toBe(426);
    expect(runtimeLog).toContain(`authorize:${ROOM_ID}`);
    expect(upgradedWith?.roomId).toBe(ROOM_ID);

    runtimeLog.length = 0;
    const upgrade = await call(app, 'GET', `/api/rooms/${ROOM_ID}/ws`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, upgrade: 'websocket' },
      env: { server: makeServer(true) },
    });
    expect(upgrade.status).toBe(200);
    expect(runtimeLog).toContain(`authorize:${ROOM_ID}`);
    expect(upgradedWith?.roomId).toBe(ROOM_ID);
    expect(upgradedWith?.session).toMatchObject({ tokenHash: expect.any(String) });
  });
});

describe('维护准入', () => {
  it('排空模式拒绝创建与匹配，但保留既有房间读取、取消和离场', async () => {
    await setup();
    const token = await sessionCookie();
    await database.db.insert(rooms).values({
      id: ROOM_ID,
      host_id: 'host',
      mode: 'private',
      theme: '主题',
      difficulty: 'hard',
      phase: 'lobby',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const revision = (await database.db.select().from(runtimeControl))[0]?.revision ?? 0;
    await enterMaintenance(database.db, revision);

    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const create = await call(app, 'POST', '/api/rooms', {
      headers,
      body: JSON.stringify({ theme: '维护契约' }),
    });
    expect(create.status).toBe(503);
    expect(create.headers.get('retry-after')).toBe('5');
    expect(await create.json()).toMatchObject({ code: 'maintenance:draining' });
    expect((await call(app, 'POST', '/api/match', { headers })).status).toBe(503);

    expect((await call(app, 'GET', `/api/rooms/${ROOM_ID}`, { headers })).status).toBe(200);
    const cancel = await call(app, 'DELETE', '/api/match', { headers });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });
    expect((await call(app, 'POST', `/api/rooms/${ROOM_ID}/leave`, { headers })).status).toBe(200);
  });

  it('健康与状态端点证明本进程的运行时租约', async () => {
    await setup();
    const healthy = await call(app, 'GET', '/health');
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({
      ok: true,
      buildId: 'unit-test',
      protocolVersion: WS_PROTOCOL,
      runtimeEpoch: 1,
    });

    const status = await call(app, 'GET', '/api/status');
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      maintenance: MaintenanceInfo;
      protocolVersion: string;
      buildId: string;
    };
    expect(body.buildId).toBe('unit-test');
    expect(body.protocolVersion).toBe(WS_PROTOCOL);
    expect(body.maintenance).toMatchObject({ mode: 'open' });

    // A runtime that has lost its lease fails readiness closed — never with a stale 200.
    const losing: RoomRuntimePort = {
      ...runtime,
      assertOwnership: async () => {
        throw new Error('lease lost');
      },
    };
    const failing = createApp({
      database: database.db,
      config: testConfig({ attempts: 1000, windowMs: 60_000 }),
      rooms: losing,
    });
    for (const path of ['/health', '/api/status']) {
      const response = await call(failing, 'GET', path);
      expect(response.status, path).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'maintenance:unavailable' });
    }

    // 没有运行时的组合（如纯 API 进程）同样拒绝，绝不假报健康。
    const runtimeless = createApp({
      database: database.db,
      config: testConfig({ attempts: 1000, windowMs: 60_000 }),
      rooms: null,
    });
    const unavailable = await call(runtimeless, 'GET', '/health');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'maintenance:unavailable' });
  });

  it('管理面只认服务端角色：未登录 401、普通用户 403、管理员按期望修订号切换', async () => {
    await setup();

    const maintenance = (
      method: string,
      cookie: string | undefined,
      data?: unknown,
      origin?: string | null,
    ) =>
      call(app, method, '/api/admin/maintenance', {
        headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` },
        origin,
        body: data === undefined ? undefined : JSON.stringify(data),
      });

    const current = (await database.db.select().from(runtimeControl))[0];
    expect(current).toMatchObject({ mode: 'open', singleton: 1 });

    // 未登录：读与写都被拒绝。
    expect((await maintenance('GET', undefined)).status).toBe(401);
    expect(
      (
        await maintenance('POST', undefined, {
          mode: 'draining',
          expectedRevision: current?.revision ?? 0,
        })
      ).status,
    ).toBe(401);

    // 普通用户：读与写都被拒绝——客户端没有任何可以自证角色的字段。
    const userCookie = await sessionAs('user', 'ordinary-user-000000001');
    expect((await maintenance('GET', userCookie)).status).toBe(403);
    expect(
      (
        await maintenance('POST', userCookie, {
          mode: 'draining',
          expectedRevision: current?.revision ?? 0,
        })
      ).status,
    ).toBe(403);

    // 管理员排空：修订号按请求推进，重复或过期修订被 409 拒绝。
    const adminCookie = await sessionAs('admin', 'admin-user-0000000001');
    const entered = await maintenance('POST', adminCookie, {
      mode: 'draining',
      expectedRevision: current?.revision ?? 0,
    });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({
      mode: 'draining',
      revision: (current?.revision ?? 0) + 1,
    });
    const stale = await maintenance('POST', adminCookie, {
      mode: 'draining',
      expectedRevision: current?.revision ?? 0,
    });
    expect(stale.status).toBe(409);

    // 状态变化跨请求可见：管理读取返回真实维护状态。
    const inspected = await maintenance('GET', adminCookie);
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ mode: 'draining' });

    // 写操作要求同源：带合法会话的跨站请求同样是 403。
    const hostile = await maintenance(
      'POST',
      adminCookie,
      { mode: 'open', expectedRevision: (current?.revision ?? 0) + 1 },
      'https://evil.example',
    );
    expect(hostile.status).toBe(403);

    // 角色是每次请求从账号行读取的：提升是数据库事实，不是会话快照。
    const inspectedAsUser = await maintenance('GET', userCookie);
    expect(inspectedAsUser.status).toBe(403);
    await database.db
      .update(accounts)
      .set({ role: 'admin' })
      .where(eq(accounts.id, 'ordinary-user-000000001'));
    expect((await maintenance('GET', userCookie)).status).toBe(200);

    // 恢复开放同样按修订号与运行时租约执行：先把控制行的租约对齐到本进程代次。
    await database.db
      .update(runtimeControl)
      .set({ runtime_id: 'runtime-unit', runtime_epoch: 1, lease_until: Date.now() + 60_000 })
      .where(eq(runtimeControl.singleton, 1));
    const resumed = await maintenance('POST', userCookie, {
      mode: 'open',
      expectedRevision: (current?.revision ?? 0) + 1,
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ mode: 'open' });
  });
});

describe('运维令牌', () => {
  const OPS_TOKEN = 'b'.repeat(64);

  /** The ops app: identical to `app` except the maintenance token it was configured with. */
  function opsApp(token: string | null) {
    if (token === null) return app;
    return createApp({
      database: database.db,
      config: { ...testConfig({ attempts: 10, windowMs: 60_000 }), maintenanceToken: token },
      rooms: runtime,
    });
  }

  function ops(
    target: RequestTarget,
    method: string,
    options: { token?: string; cookie?: string; data?: unknown } = {},
  ): Promise<Response> {
    return call(target, method, '/api/ops/maintenance', {
      // The bearer path is not an ambient credential: no Origin gate applies here.
      origin: null,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
      },
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    });
  }

  it('未配置、缺失与错误的令牌一律失败关闭，会话Cookie不是替代凭据', async () => {
    await setup();

    // 未配置 MAINTENANCE_TOKEN：整个运维面不可用，即使带着任意令牌。
    const disabled = await ops(app, 'GET', { token: OPS_TOKEN });
    expect(disabled.status).toBe(503);

    const automation = opsApp(OPS_TOKEN);
    expect((await ops(automation, 'GET', {})).status).toBe(401);
    expect((await ops(automation, 'GET', { token: 'a'.repeat(64) })).status).toBe(401);
    expect((await ops(automation, 'GET', { token: 'not-a-token' })).status).toBe(401);
    expect(
      (
        await ops(automation, 'POST', {
          token: OPS_TOKEN.slice(0, -1) + 'c',
          data: { mode: 'draining', expectedRevision: 0 },
        })
      ).status,
    ).toBe(401);

    // 管理员或普通用户的会话Cookie不能调用运维面：令牌不落会话，会话不落令牌。
    const adminCookie = await sessionAs('admin', 'ops-admin-00000000001');
    expect((await ops(automation, 'GET', { cookie: adminCookie })).status).toBe(401);
    expect(
      (
        await ops(automation, 'POST', {
          cookie: adminCookie,
          data: { mode: 'draining', expectedRevision: 0 },
        })
      ).status,
    ).toBe(401);

    // 反方向同样关闭：令牌不能代替会话调用管理面。
    const adminViaToken = await call(automation, 'GET', '/api/admin/maintenance', {
      origin: null,
      headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    expect(adminViaToken.status).toBe(401);
  });

  it('有效令牌读取状态并按修订号排空；过期修订被拒绝', async () => {
    await setup();
    const automation = opsApp(OPS_TOKEN);

    const status = await ops(automation, 'GET', { token: OPS_TOKEN });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ mode: 'open', revision: 0 });

    const drained = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'draining', expectedRevision: 0 },
    });
    expect(drained.status).toBe(200);
    expect(await drained.json()).toMatchObject({ mode: 'draining', revision: 1 });

    const stale = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'draining', expectedRevision: 0 },
    });
    expect(stale.status).toBe(409);

    // 排空对游戏边界的影响与人类管理面一致：新对局被拒，既有房间仍可读。
    const refused = await call(automation, 'POST', '/api/rooms', {
      body: JSON.stringify({ theme: '运维排空' }),
    });
    expect(refused.status).toBe(401); // 令牌不授予任何用户 API；无会话即 401
  });

  it('恢复开放要求显式运行时代次：本地代次与数据库租约代次各自校验', async () => {
    await setup();
    const automation = opsApp(OPS_TOKEN);
    await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'draining', expectedRevision: 0 },
    });

    // 恢复必须携带期望运行时代次：缺失是 400 的请求形状错误。
    const missingEpoch = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'open', expectedRevision: 1 },
    });
    expect(missingEpoch.status).toBe(400);

    // 本进程的代次是 1：声称其他代次在本地校验就被拒绝，绝不触库。
    const foreignEpoch = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'open', expectedRevision: 1, expectedRuntimeEpoch: 999 },
    });
    expect(foreignEpoch.status).toBe(409);

    // 数据库里是更新代次的租约：本地校验通过后，数据库 CAS 仍然拒绝旧运行时。
    await database.db
      .update(runtimeControl)
      .set({ runtime_id: 'successor', runtime_epoch: 7, lease_until: Date.now() + 60_000 })
      .where(eq(runtimeControl.singleton, 1));
    const superseded = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'open', expectedRevision: 1, expectedRuntimeEpoch: 1 },
    });
    expect(superseded.status).toBe(409);

    // 本地代次与数据库租约一致：恢复开放成功。
    await database.db
      .update(runtimeControl)
      .set({ runtime_id: 'runtime-unit', runtime_epoch: 1, lease_until: Date.now() + 60_000 })
      .where(eq(runtimeControl.singleton, 1));
    const resumed = await ops(automation, 'POST', {
      token: OPS_TOKEN,
      data: { mode: 'open', expectedRevision: 1, expectedRuntimeEpoch: 1 },
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ mode: 'open', revision: 2 });
  });
});

describe('认证限流', () => {
  it('同一客户端的重复尝试在窗口内被计数并拒绝，作用域之间互不占用', async () => {
    await setup();
    // database 共享，但限流器随 app 实例重建；这里换一个 3 次预算的实例。
    const strict = createApp({
      database: database.db,
      config: testConfig({ attempts: 3, windowMs: 60_000 }),
      rooms: runtime,
    });
    const start = (index: number) =>
      call(strict, 'GET', `/api/auth/wechat/start?room=${index.toString(16).padStart(24, '0')}`);
    for (let index = 1; index <= 3; index += 1) {
      expect((await start(index)).status).toBe(302);
    }
    const limited = await start(99);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: '尝试次数过多，请稍后再试' });
    // 其他接口的预算不受影响：回调仍然是独立作用域。
    const callback = await call(strict, 'GET', '/api/auth/wechat/callback');
    expect(callback.status).toBe(302);
  });

  it('客户端自带的转发头不能伪造或轮换身份来绕过预算', async () => {
    await setup();
    // trustForwardedFor=false（本地/开发默认）：无论请求怎么换 X-Forwarded-For，
    // 都使用连接身份；这里给默认预算 10。
    const strict = createApp({
      database: database.db,
      config: testConfig({ attempts: 10, windowMs: 60_000 }),
      rooms: runtime,
    });
    const spoof = (index: number) =>
      call(strict, 'GET', '/api/auth/wechat/start', {
        headers: { 'x-forwarded-for': `${index}.0.0.1` },
      });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await spoof(index)).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it('自定义客户端 IP 头独立限流，忽略其他转发头，缺失时使用连接 IP', async () => {
    await setup();
    const config = await readServerConfig({ TRUST_FORWARDED_FOR: 'EO-Client-IP' });
    const strict = createApp({
      database: database.db,
      config: { ...config, authLimits: { attempts: 1, windowMs: 60_000 } },
      rooms: runtime,
    });
    const start = (client: string | undefined, forwarded: string) =>
      call(strict, 'GET', '/api/auth/wechat/start', {
        headers: { 'eo-client-ip': client, 'x-forwarded-for': forwarded },
        env: { server: { requestIP: () => ({ address: '203.0.113.10' }) } },
      });
    expect((await start('198.51.100.1', '192.0.2.1')).status).toBe(302);
    expect((await start('198.51.100.1', '192.0.2.2')).status).toBe(429);
    expect((await start('198.51.100.2', '192.0.2.1')).status).toBe(302);
    expect((await start(undefined, '192.0.2.3')).status).toBe(302);
    expect((await start('  ', '192.0.2.4')).status).toBe(429);
    expect((await start('203.0.113.10', '192.0.2.5')).status).toBe(429);
  });

  it('true 使用 X-Forwarded-For 最右侧地址，而不是客户端可添加的前缀', async () => {
    await setup();
    const config = await readServerConfig({ TRUST_FORWARDED_FOR: 'true' });
    const strict = createApp({
      database: database.db,
      config: { ...config, authLimits: { attempts: 1, windowMs: 60_000 } },
      rooms: runtime,
    });
    const start = (forwarded: string) =>
      call(strict, 'GET', '/api/auth/wechat/start', {
        headers: { 'x-forwarded-for': forwarded },
      });
    expect((await start('192.0.2.1, 198.51.100.1')).status).toBe(302);
    expect((await start('192.0.2.2, 198.51.100.1')).status).toBe(429);
    expect((await start('192.0.2.1, 198.51.100.2')).status).toBe(302);
  });
});
