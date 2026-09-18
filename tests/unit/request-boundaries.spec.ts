/**
 * Request input boundaries — the gates every state change, WebSocket handshake and JSON body
 * passes through.
 *
 * Every case is driven through the real Hono apps (`server/http/app.ts`) over a real PGlite
 * database, so what is pinned is the behaviour of the migrated boundary itself: the same-origin
 * gate on state changes and WebSocket handshakes, the body cap (which must cut an oversized
 * stream, not buffer it), the narrowing of untrusted request values, the release gates (client
 * header, WS query, mounted URL, release lifecycle, persisted room release), native method/route
 * handling, and the JSON body contract.
 *
 * The game app is mounted exactly the way Main mounts it in production — at
 * `/api/releases/<releaseId>` — so the paths under test are the paths that ship. A stub
 * `RoomRuntimePort` fails loudly if a gate lets a request through that should never reach the
 * runtime.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { MAX_API_BODY_BYTES, MAX_THEME_CHARS, WS_PROTOCOL } from '../../shared/protocol';
import type { RoomSnapshot } from '../../shared/protocol';
import { DEV_RELEASE_ID, gameApiBase } from '../../shared/release';
import { themeSchema } from '../../shared/validation';
import { SESSION_COOKIE } from '../../server/auth/sessions';
import type { ServerConfig } from '../../server/config';
import type { RoomRuntimePort } from '../../server/contracts';
import type { Database, OpenedDatabase } from '../../server/db';
import { openDatabase } from '../../server/db';
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
import {
  createGameApp,
  createStableApp,
  type HttpEnv,
  type ServerApp,
} from '../../server/http/app';
import { parsedString, rejected } from '../support/schema-probe';

const ORIGIN = 'https://app.example';
const RELEASE = DEV_RELEASE_ID;
const OTHER_RELEASE = 'e'.repeat(32);
const ROOM_ID = '0123456789abcdef01234567';
const GAME_BASE = gameApiBase(RELEASE);

const minimalSnapshot = (roomId: string): RoomSnapshot => ({
  id: roomId,
  protocolVersion: WS_PROTOCOL,
  releaseId: RELEASE,
  draining: false,
  matchId: null,
  hostId: 'host',
  mode: 'private',
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
  releaseId: RELEASE,
  runtimeEpoch: 1,
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
let stableApp: ServerApp;
let gameRoot: ServerApp;
let gameStandalone: ServerApp;

async function seedRelease(
  releaseId: string,
  state: 'staged' | 'active' | 'retiring' | 'retired',
  patch: { runtime_epoch?: number; lease_until?: number | null } = {},
): Promise<void> {
  const values = {
    id: releaseId,
    state,
    artifact_digest: 'a'.repeat(64),
    operation_id: '00000000-0000-0000-0000-000000000000',
    runtime_id: 'runtime-1',
    runtime_epoch: 1,
    lease_until: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...patch,
  };
  await database.db
    .insert(releaseVersions)
    .values(values)
    .onConflictDoUpdate({
      target: releaseVersions.id,
      set: {
        state: values.state,
        runtime_epoch: values.runtime_epoch,
        lease_until: values.lease_until,
      },
    });
}

async function seedControl(activeReleaseId: string | null): Promise<void> {
  await database.db
    .insert(releaseControl)
    .values({
      singleton: 1,
      active_release_id: activeReleaseId,
      revision: 0,
      updated_at: Date.now(),
    })
    .onConflictDoUpdate({
      target: releaseControl.singleton,
      set: { active_release_id: activeReleaseId, updated_at: Date.now() },
    });
}

async function seedRoom(roomId: string, releaseId: string = RELEASE): Promise<void> {
  await database.db.insert(rooms).values({
    id: roomId,
    release_id: releaseId,
    host_id: '000000000000000000000000',
    mode: 'private',
    theme: '主题',
    difficulty: 'hard',
    phase: 'lobby',
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

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

/** A fresh environment per test: every gate sees the same clean database and release state. */
async function setup(): Promise<void> {
  database ??= await openDatabase('pglite://:memory:');
  await wipeEverything(database.db);
  runtimeLog.length = 0;
  await seedRelease(RELEASE, 'active');
  await seedControl(RELEASE);
  const services = {
    database: database.db,
    config: testConfig({ attempts: 1000, windowMs: 60_000 }),
    rooms: runtime,
  };
  stableApp = createStableApp(services);
  gameRoot = new Hono<HttpEnv>();
  gameRoot.route(GAME_BASE, createGameApp(services));
  // 直接以完整路径驱动 app 本身：挂载闸门与 notFound 属于这个实例。
  gameStandalone = createGameApp(services);
}

/** A ServerConfig literal for tests, with the auth budget the scenario needs. */
function testConfig(authLimits: { attempts: number; windowMs: number }): ServerConfig {
  return {
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
    authLimits,
    trustForwardedFor: false,
    matchAdmission: 'open',
    inputPolicyMode: 'observe',
  };
}

/** Shaped after the real `fetch` request the browser makes. */
async function call(
  app: ServerApp,
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
  const pathname = new URL(path, ORIGIN).pathname;
  if (method === 'GET' && /^\/api\/releases\/[0-9a-f]{32}\/rooms\/[^/]+$/.test(pathname)) {
    headers.set('x-spelltype-protocol', WS_PROTOCOL);
  }
  if (method === 'GET' && pathname.endsWith('/ws')) {
    headers.set('sec-websocket-protocol', WS_PROTOCOL);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(`${ORIGIN}${path}`, { method, headers, body: options.body }, options.env);
}

/** Registers an account and returns its session cookie for authenticated requests. */
async function sessionCookie(): Promise<string> {
  const response = await call(stableApp, 'POST', '/api/register', {
    body: JSON.stringify({ username: '咒文使', password: 'correct horse battery' }),
  });
  expect(response.status).toBe(200);
  const header = response.headers.get('set-cookie') ?? '';
  return header.slice(`${SESSION_COOKIE}=`.length).split(';')[0];
}

const STABLE_STATE_CHANGES = [
  {
    method: 'POST',
    path: '/api/register',
    body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
  },
  {
    method: 'POST',
    path: '/api/login',
    body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
  },
  { method: 'POST', path: '/api/logout' },
];

const GAME_STATE_CHANGES = [
  { method: 'POST', path: `${GAME_BASE}/rooms`, body: JSON.stringify({ theme: '咒文契约' }) },
  { method: 'POST', path: `${GAME_BASE}/match` },
  { method: 'DELETE', path: `${GAME_BASE}/match` },
  { method: 'POST', path: `${GAME_BASE}/rooms/${ROOM_ID}/leave` },
  { method: 'GET', path: `${GAME_BASE}/rooms/${ROOM_ID}/ws` },
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
    for (const { method, path, body } of STABLE_STATE_CHANGES) {
      for (const origin of hostile) {
        const response = await call(stableApp, method, path, { origin, body });
        expect(response.status, `${method} ${path} origin=${origin}`).toBe(403);
      }
    }
  });

  it('游戏端的每一个状态变更与 WebSocket 握手都要求规范来源', async () => {
    await setup();
    const hostile = [null, 'https://evil.example', 'http://app.example', 'https://app.example/'];
    for (const { method, path, body } of GAME_STATE_CHANGES) {
      for (const origin of hostile) {
        const response = await call(gameRoot, method, path, { origin, body });
        expect(response.status, `${method} ${path} origin=${origin}`).toBe(403);
      }
    }
  });

  it('拒绝时返回统一的 JSON 错误体，且不被缓存', async () => {
    await setup();
    const response = await call(stableApp, 'POST', '/api/logout', {
      origin: 'https://evil.example',
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: '请求来源不受信任' });
  });

  it('规范来源能通过该闸门，走到各自的下一个判定', async () => {
    await setup();
    // 无会话的登出没有可吊销的内容：闸门放行后即成功。
    expect(await (await call(stableApp, 'POST', '/api/logout')).json()).toEqual({ ok: true });

    // 注册到达 schema：用户名的长度判定，而不是来源判定。
    const shortUsername = await call(stableApp, 'POST', '/api/register', {
      body: JSON.stringify({ username: 'a', password: 'correct horse' }),
    });
    expect(shortUsername.status).toBe(400);

    // 带会话的接口到达鉴权：无 Cookie 即 401。
    expect((await call(gameRoot, 'POST', `${GAME_BASE}/match`)).status).toBe(401);
    expect((await call(gameRoot, 'POST', `${GAME_BASE}/rooms/${ROOM_ID}/leave`)).status).toBe(401);

    // 房间握手到达升级判定：普通 GET 即 426。
    expect((await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}/ws`)).status).toBe(426);
  });
});

describe('房间号', () => {
  it('形状不对的房间号在进入房间流程之前就被拒绝', async () => {
    await setup();
    const response = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/not-a-room-id/ws`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '房间不存在' });
  });
});

describe('请求体上限', () => {
  it('声明超限与流式超限都被截断为 413', async () => {
    await setup();
    const declared = await call(stableApp, 'POST', '/api/register', {
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
      headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: '请求内容过大' });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ username: 'ab', password: 'x'.repeat(MAX_API_BODY_BYTES) }),
          ),
        );
        controller.close();
      },
    });
    const chunked = await call(stableApp, 'POST', '/api/register', { body: stream });
    expect(chunked.status).toBe(413);
  });

  it('游戏端建房同样受统一上限约束', async () => {
    await setup();
    const response = await call(gameRoot, 'POST', `${GAME_BASE}/rooms`, {
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
      headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(413);
  });

  it('无长度声明的分块请求体在上限内照常解析', async () => {
    await setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ username: 'a', password: 'correct horse' })),
        );
        controller.close();
      },
    });
    const response = await call(stableApp, 'POST', '/api/register', { body: stream });
    // 上限内的分块请求体同样被读入并交给 schema：这是用户名的 400。
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('用户名') });
  });

  it('恰好等于上限的请求体不被截断，而是照常解析并校验', async () => {
    await setup();
    const template = JSON.stringify({ username: 'ab', password: 'x', pad: '' });
    const body = JSON.stringify({
      username: 'ab',
      password: 'x',
      pad: 'x'.repeat(MAX_API_BODY_BYTES - template.length),
    });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_API_BODY_BYTES);

    const response = await call(stableApp, 'POST', '/api/register', { body });
    // 请求体真的被读入并交给了 schema：这是密码长度的 400，而不是上限的 413。
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('密码至少') });
  });
});

describe('JSON 请求体', () => {
  it('非法 JSON、空体、非对象与错误形状都是 400 且带 JSON 错误体', async () => {
    await setup();
    const bodies = [
      '{oops',
      '',
      '[]',
      'null',
      '"text"',
      '{}',
      '{"username":"ab"}',
      '{"username":"ab","password":1}',
    ];
    for (const body of bodies) {
      const response = await call(stableApp, 'POST', '/api/register', { body });
      expect(response.status, body || 'empty').toBe(400);
      const payload = (await response.json()) as { error?: unknown };
      expect(typeof payload.error, body || 'empty').toBe('string');
      expect((payload.error as string).length, body || 'empty').toBeGreaterThan(0);
    }
  });

  it('非 JSON 的 Content-Type 不能绕过校验', async () => {
    await setup();
    const response = await call(stableApp, 'POST', '/api/register', {
      body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(400);
  });

  it('登录的形状错误不构成账号预言：与错误口令一样是 401', async () => {
    await setup();
    for (const body of ['{oops', '', '[]', '{}']) {
      const response = await call(stableApp, 'POST', '/api/login', { body });
      expect(response.status, body || 'empty').toBe(401);
      expect(await response.json()).toEqual({ error: '用户名或密码不正确' });
    }
  });

  it('未预期的故障是 500 JSON，不泄露内部信息', async () => {
    await setup();
    const failingDatabase = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === 'insert') throw new Error('db down: SELECT secret');
        return Reflect.get(target, property, receiver);
      },
    });
    const failing = createStableApp({
      database: failingDatabase,
      config: testConfig({ attempts: 10, windowMs: 60_000 }),
      rooms: null,
    });
    const response = await call(failing, 'POST', '/api/register', {
      body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
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
      ['DELETE', '/api/register', ['POST']],
      ['POST', `${GAME_BASE}/rooms/${ROOM_ID}/ws`, ['GET', 'HEAD']],
      ['GET', `${GAME_BASE}/match`, ['POST', 'DELETE']],
      ['DELETE', `${GAME_BASE}/rooms/${ROOM_ID}/leave`, ['POST']],
    ] as const) {
      const response = await call(path.startsWith(GAME_BASE) ? gameRoot : stableApp, method, path);
      expect(response.status, `${method} ${path}`).toBe(405);
      const allow = (response.headers.get('allow') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      expect(allow.sort(), `${method} ${path}`).toEqual(Array.from(allowed).sort());
      expect(await response.json()).toEqual({ error: '请求方法不被支持' });
    }
  });

  it('未知接口是 404，未知方法也不例外；旧根路径别名不复存在', async () => {
    await setup();
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await call(stableApp, method, '/api/unknown');
      expect(response.status, method).toBe(404);
      expect(await response.json()).toEqual({ error: '接口不存在' });
    }
    // 旧的根级游戏别名已删除：新房只能开在发布前缀下。
    for (const path of ['/api/rooms', '/api/match']) {
      const response = await call(stableApp, 'POST', path);
      expect(response.status, path).toBe(404);
    }
    // app 自身对未知路径的 404 是 JSON（组合层可再挂静态资源兜底）。
    const gameUnknown = await call(gameStandalone, 'GET', `${GAME_BASE}/unknown`);
    expect(gameUnknown.status).toBe(404);
    expect(await gameUnknown.json()).toEqual({ error: '接口不存在' });
  });

  it('挂载前缀里的版本不是本进程编译版本时，整个前缀不存在', async () => {
    await setup();
    const response = await call(gameStandalone, 'POST', `/api/releases/${OTHER_RELEASE}/rooms`, {
      body: JSON.stringify({ theme: '咒文契约' }),
      headers: { 'x-spelltype-release': RELEASE },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '接口不存在' });
  });

  it('非接口路径交给组合层的静态资源，稳定端不再吞掉它', async () => {
    await setup();
    const page = await call(stableApp, 'GET', '/lobby/abc');
    expect(page.status).toBe(404);
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

describe('版本准入', () => {
  it('缺少、为空或错误的客户端版本都不能建房、入队或取消', async () => {
    await setup();
    const cookie = await sessionCookie();
    for (const header of [undefined, '', 'not-a-release', OTHER_RELEASE]) {
      const headers: Record<string, string> = {
        cookie: `${SESSION_COOKIE}=${cookie}`,
      };
      if (header !== undefined) headers['x-spelltype-release'] = header;
      const created = await call(gameRoot, 'POST', `${GAME_BASE}/rooms`, {
        body: JSON.stringify({ theme: '咒文契约' }),
        headers,
      });
      expect(created.status, `header=${header}`).toBe(409);
      expect(await created.json()).toEqual({
        code: 'release:update_required',
        error: '版本已更新，请更新页面后重试。',
        activeReleaseId: RELEASE,
      });
      expect((await call(gameRoot, 'POST', `${GAME_BASE}/match`, { headers })).status).toBe(409);
      expect((await call(gameRoot, 'DELETE', `${GAME_BASE}/match`, { headers })).status).toBe(409);
    }
    // 没有任何请求到达运行时。
    expect(runtimeLog).toEqual([]);
  });

  it('正确版本的建房被准入：房间落库、运行时接手，快照可读', async () => {
    await setup();
    const cookie = await sessionCookie();
    const created = await call(gameRoot, 'POST', `${GAME_BASE}/rooms`, {
      body: JSON.stringify({ theme: '咒文契约' }),
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(created.status).toBe(200);
    const { roomId } = (await created.json()) as { roomId: string };
    expect(roomId).toMatch(/^[0-9a-f]{24}$/);
    expect(runtimeLog).toContain(`refresh:${roomId}`);

    const seeded = await database.db.select().from(rooms);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.id).toBe(roomId);
    expect(seeded[0]?.release_id).toBe(RELEASE);
    expect(seeded[0]?.host_id).toBeDefined();

    const snapshot = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${roomId}`, {
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ id: roomId, releaseId: RELEASE });
  });

  it('WebSocket 握手通过 release 查询参数核验版本：缺失或错误都是 409', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    for (const query of ['', '?release=', `?release=${OTHER_RELEASE}`, '?release=dev']) {
      const response = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}/ws${query}`, {
        headers: { cookie: `${SESSION_COOKIE}=${cookie}`, upgrade: 'websocket' },
      });
      expect(response.status, `query=${query}`).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'release:update_required' });
    }
    expect(runtimeLog).toEqual([]);
  });

  it('授权通过后以 roomId 和会话升级连接', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    let upgradedWith: { roomId: string; session: unknown } | undefined;
    const server = {
      upgrade: (_request: Request, options: { data: { roomId: string; session: unknown } }) => {
        upgradedWith = options.data;
        return false;
      },
    };
    const rejected = await call(
      gameRoot,
      'GET',
      `${GAME_BASE}/rooms/${ROOM_ID}/ws?release=${RELEASE}`,
      {
        headers: { cookie: `${SESSION_COOKIE}=${cookie}`, upgrade: 'websocket' },
        env: { server },
      },
    );
    // 升级被底层拒绝时，客户端拿到的是明确的 426，而不是半个 socket。
    expect(rejected.status).toBe(426);
    expect(runtimeLog).toContain(`authorize:${ROOM_ID}`);
    expect(upgradedWith?.roomId).toBe(ROOM_ID);

    const accepting = {
      upgrade: (_request: Request, options: { data: { roomId: string; session: unknown } }) => {
        upgradedWith = options.data;
        return true;
      },
    };
    const upgrade = await call(
      gameRoot,
      'GET',
      `${GAME_BASE}/rooms/${ROOM_ID}/ws?release=${RELEASE}`,
      {
        headers: { cookie: `${SESSION_COOKIE}=${cookie}`, upgrade: 'websocket' },
        env: { server: accepting },
      },
    );
    expect(upgrade.status).toBe(200);
    expect(upgradedWith?.roomId).toBe(ROOM_ID);
    expect(upgradedWith?.session).toMatchObject({ tokenHash: expect.any(String) });
  });

  it('本版本退役后，容器还在也不能再服务任何游戏请求', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    await seedRelease(RELEASE, 'retired');
    const headers = { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` };
    for (const attempt of [
      () =>
        call(gameRoot, 'POST', `${GAME_BASE}/rooms`, {
          body: JSON.stringify({ theme: '咒文契约' }),
          headers,
        }),
      () => call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, { headers }),
      () => call(gameRoot, 'POST', `${GAME_BASE}/match`, { headers }),
      () => call(gameRoot, 'DELETE', `${GAME_BASE}/match`, { headers }),
      () =>
        call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}/ws?release=${RELEASE}`, {
          headers: { ...headers, upgrade: 'websocket' },
        }),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'release:update_required' });
    }
  });

  it('尚未启用（staged）或控制行缺失的版本一律不可用', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    await seedRelease(RELEASE, 'staged');
    const staged = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, {
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(staged.status).toBe(503);
    expect(await staged.json()).toMatchObject({ code: 'release:unavailable' });

    await database.db.delete(releaseControl);
    const missing = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, {
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: 'release:unavailable' });
  });

  it('别的版本持久化的房间对本客户端是退休房间', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRelease(OTHER_RELEASE, 'retiring');
    await seedRoom(ROOM_ID, OTHER_RELEASE);
    await seedControl(OTHER_RELEASE);
    const response = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, {
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(response.status).toBe(409);
    // 错误体里的指针是当前真正的准入版本（新版 B），客户端据此回首页刷新。
    expect(await response.json()).toEqual({
      code: 'release:room_retired',
      error: '这个房间已经结束，请返回首页开始新的对局。',
      activeReleaseId: OTHER_RELEASE,
    });
  });

  it('retiring 版本仍然允许重连已有房间', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    await seedRelease(RELEASE, 'retiring');
    await seedRelease(OTHER_RELEASE, 'active');
    await seedControl(OTHER_RELEASE);
    const response = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, {
      headers: { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(response.status).toBe(200);
    expect(runtimeLog).toContain(`snapshot:${ROOM_ID}`);
  });
});

describe('房间定位与健康', () => {
  it('定位端点需要会话，返回保留的房间版本与兼容入口', async () => {
    await setup();
    expect((await call(stableApp, 'GET', `/api/rooms/${ROOM_ID}/location`)).status).toBe(401);

    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    const found = await call(stableApp, 'GET', `/api/rooms/${ROOM_ID}/location`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      roomId: ROOM_ID,
      releaseId: RELEASE,
      state: 'active',
      entryUrl: `/?room=${ROOM_ID}`,
    });

    expect(
      (
        await call(stableApp, 'GET', `/api/rooms/${'f'.repeat(24)}/location`, {
          headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
        })
      ).status,
    ).toBe(404);
    const malformed = await call(stableApp, 'GET', '/api/rooms/not-a-room/location', {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(malformed.status).toBe(404);
  });

  it('健康端点报告本进程的 ownership 代次，仅在数据库租约佐证时有效', async () => {
    await setup();
    const healthy = await call(gameRoot, 'GET', `${GAME_BASE}/health`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ releaseId: RELEASE, runtimeEpoch: 1 });

    await seedRelease(RELEASE, 'active', { runtime_epoch: 2 });
    const superseded = await call(gameRoot, 'GET', `${GAME_BASE}/health`);
    expect(superseded.status).toBe(503);

    await seedRelease(RELEASE, 'active', { lease_until: Date.now() - 1 });
    const lapsed = await call(gameRoot, 'GET', `${GAME_BASE}/health`);
    expect(lapsed.status).toBe(503);

    await seedRelease(RELEASE, 'retired');
    const retired = await call(gameRoot, 'GET', `${GAME_BASE}/health`);
    expect(retired.status).toBe(503);
  });
});

describe('认证限流', () => {
  it('同一客户端的重复尝试在窗口内被计数并拒绝，作用域之间互不占用', async () => {
    await setup();
    // database 共享，但限流器随 app 实例重建；这里换一个 3 次预算的实例。
    const strict = createStableApp({
      database: database.db,
      config: testConfig({ attempts: 3, windowMs: 60_000 }),
      rooms: null,
    });
    const attempt = (index: number) =>
      call(strict, 'POST', '/api/register', {
        body: JSON.stringify({ username: `用户${index}`, password: 'correct horse' }),
      });
    for (let index = 1; index <= 3; index += 1) {
      expect((await attempt(index)).status).toBe(200);
    }
    const limited = await attempt(99);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: '尝试次数过多，请稍后再试' });
    // 其他接口的预算不受影响：登录仍然是独立作用域。
    const login = await call(strict, 'POST', '/api/login', {
      body: JSON.stringify({ username: '用户1', password: 'wrong password' }),
    });
    expect(login.status).toBe(401);
  });

  it('客户端自带的转发头不能伪造或轮换身份来绕过预算', async () => {
    await setup();
    // trustForwardedFor=false（本地/开发默认）：无论请求怎么换 X-Forwarded-For，
    // 无真实内部边缘背书的请求都落在同一个不可伪造的键上；这里给默认预算 10。
    const strict = createStableApp({
      database: database.db,
      config: testConfig({ attempts: 10, windowMs: 60_000 }),
      rooms: null,
    });
    const spoof = (index: number) =>
      call(strict, 'POST', '/api/register', {
        body: JSON.stringify({ username: `伪装${index}`, password: 'correct horse' }),
        headers: { 'x-forwarded-for': `${index}.0.0.1` },
      });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await spoof(index)).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe('v2 协议与维护准入', () => {
  it('房间快照要求当前协议，握手拒绝缺失或旧协议，但释放操作不要求协议头', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    const headers = { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` };
    for (const protocol of [undefined, 'spelltype.v1']) {
      const snapshot = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, {
        headers: { ...headers, 'x-spelltype-protocol': protocol },
      });
      expect(snapshot.status).toBe(409);
      expect(await snapshot.json()).toMatchObject({ protocolVersion: WS_PROTOCOL });
      const socket = await call(
        gameRoot,
        'GET',
        `${GAME_BASE}/rooms/${ROOM_ID}/ws?release=${RELEASE}`,
        {
          headers: { ...headers, upgrade: 'websocket', 'sec-websocket-protocol': protocol },
        },
      );
      expect(socket.status).toBe(426);
      expect(await socket.json()).toMatchObject({ protocolVersion: WS_PROTOCOL });
    }
    const current = await call(gameRoot, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, { headers });
    expect(current.status).toBe(200);
    const leave = await call(gameRoot, 'POST', `${GAME_BASE}/rooms/${ROOM_ID}/leave`, { headers });
    expect(leave.status).toBe(200);
    expect(await leave.json()).toEqual({ left: true });
  });

  it('维护模式拒绝创建与匹配，但保留既有房间读取和取消释放', async () => {
    await setup();
    const cookie = await sessionCookie();
    await seedRoom(ROOM_ID);
    const config = {
      ...testConfig({ attempts: 1000, windowMs: 60_000 }),
      matchAdmission: 'draining' as const,
    };
    const maintenance = new Hono<HttpEnv>().route(
      GAME_BASE,
      createGameApp({ database: database.db, config, rooms: runtime }),
    );
    const headers = { 'x-spelltype-release': RELEASE, cookie: `${SESSION_COOKIE}=${cookie}` };
    const create = await call(maintenance, 'POST', `${GAME_BASE}/rooms`, {
      headers,
      body: JSON.stringify({ theme: '维护契约' }),
    });
    expect(create.status).toBe(503);
    expect((await call(maintenance, 'POST', `${GAME_BASE}/match`, { headers })).status).toBe(503);
    expect(
      (await call(maintenance, 'GET', `${GAME_BASE}/rooms/${ROOM_ID}`, { headers })).status,
    ).toBe(200);
    const cancel = await call(maintenance, 'DELETE', `${GAME_BASE}/match`, { headers });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });
    expect(
      (await call(maintenance, 'POST', `${GAME_BASE}/rooms/${ROOM_ID}/leave`, { headers })).status,
    ).toBe(200);
  });
});
