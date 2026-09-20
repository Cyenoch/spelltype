/**
 * 账户封禁 —— 管理端下发、会话如实上报、受保护面全面拒绝、到期自动解除。
 *
 * 封禁落在账户上而非会话上：`/api/session` 与登出永远可用并携带封禁状态供界面提示，
 * 其余受保护接口（个人资料、建房、匹配、WS 握手）在封禁生效后的下一次请求即被拒绝，
 * 在册的全部旧会话一并受约束；定时封禁以权威服务器时间到期，无需任何清理任务。
 * 在线连接的终止通过运行时端口如实确认 —— 无法确认时端点以 503 收场，封禁本身保留。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  MAX_BAN_DURATION_MS,
  type AdminPage,
  type AdminUser,
  type AdminUserDetail,
} from '../../shared/admin';
import type { AccountBan, SessionInfo } from '../../shared/protocol';
import { createSession, hashToken, SESSION_COOKIE } from '../../server/auth/sessions';
import type { RoomRuntimePort } from '../../server/contracts';
import type { ServerConfig } from '../../server/config';
import { accounts, openDatabase, type OpenedDatabase } from '../../server/db';
import { createApp, type AppType } from '../../server/http/app';
import { createRoom, createRoomRuntime } from '../../server/rooms';

const ORIGIN = 'https://app.example';
const ROOM_ID = '0123456789abcdef01234567';

let database: OpenedDatabase;
let app: Pick<AppType, 'request'>;

const config: ServerConfig = {
  buildId: 'account-bans-test',
  databaseUrl: 'pglite://:memory:',
  hostname: '127.0.0.1',
  port: 0,
  publicOrigin: ORIGIN,
  maintenanceToken: null,
  assetsRoot: null,
  ai: { apiKey: null, model: 'test' },
  authLimits: { attempts: 1000, windowMs: 60_000 },
  trustForwardedFor: false,
  wechatBridge: null,
  inputPolicyMode: 'observe',
};

/** 封禁端点触发的账户级断开记录；`failRevocation` 注入断开失败以驱动 503 路径。 */
const revoked: string[] = [];
let failRevocation = false;
const stubRuntime: RoomRuntimePort = {
  runtimeEpoch: 1,
  assertOwnership: async () => {},
  snapshot: async () => {
    throw new Error('封禁测试不读取房间快照');
  },
  authorizeSocket: async () => {},
  connect: () => {},
  message: () => {},
  disconnect: () => {},
  leaveRoom: async () => {},
  revokeSession: async () => {},
  revokeUser: async (userId) => {
    if (failRevocation) throw new Error('room:revoke_incomplete');
    revoked.push(userId);
  },
  refreshRoom: async () => {},
  close: async () => {},
};

let adminCookie: string;
let player1Cookie: string;

beforeAll(async () => {
  database = await openDatabase('pglite://:memory:');
  const db = database.db;
  const now = Date.now();
  await db.insert(accounts).values([
    {
      id: 'admin-1',
      username: '运维法师',
      role: 'admin',
      wechat_identity: 'union:ban-admin',
      created_at: now,
    },
    {
      id: 'player-1',
      username: '受罚学徒',
      role: 'user',
      wechat_identity: 'union:ban-player-1',
      created_at: now,
    },
    {
      id: 'player-2',
      username: '戴罪立功',
      role: 'user',
      wechat_identity: 'union:ban-player-2',
      created_at: now,
    },
  ]);
  adminCookie = `${SESSION_COOKIE}=${(await createSession(db, 'admin-1')).token}`;
  player1Cookie = `${SESSION_COOKIE}=${(await createSession(db, 'player-1')).token}`;
  app = createApp({ database: db, config, rooms: stubRuntime });
});

afterAll(async () => {
  await database?.close();
});

afterEach(async () => {
  failRevocation = false;
  revoked.splice(0);
  // 封禁是账户行上的状态：每个用例结束前恢复为从未封禁。
  await database.db
    .update(accounts)
    .set({ banned_at: null, ban_expires_at: null })
    .where(eq(accounts.id, 'player-1'));
  await database.db
    .update(accounts)
    .set({ banned_at: null, ban_expires_at: null })
    .where(eq(accounts.id, 'player-2'));
});

/** 封禁下发响应的边界类型。 */
interface BanIssued {
  ban: AccountBan;
}

function adminRequest(path: string, init: { headers?: Record<string, string> } = {}) {
  return app.request(`/api/admin${path}`, {
    ...init,
    headers: { cookie: adminCookie, ...init.headers },
  });
}

function banRequest(
  userId: string,
  body: unknown,
  cookie = adminCookie,
  extraHeaders: Record<string, string> = {},
) {
  return app.request(`/api/admin/users/${userId}/ban`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ORIGIN,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function gameRequest(
  method: string,
  path: string,
  cookie: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.request(path, { method, headers: { cookie, origin: ORIGIN, ...extraHeaders } });
}

async function errorOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body;
    if (typeof error === 'string') return error;
  }
  throw new Error('响应未携带错误信息');
}

async function sessionBody(cookie: string): Promise<SessionInfo> {
  const response = await app.request('/api/session', { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

describe('封禁端点的授权与输入边界', () => {
  it('非管理员禁止封禁：403 且账户与运行时纹丝不动', async () => {
    const response = await banRequest('player-1', { durationMs: null }, player1Cookie);
    expect(response.status).toBe(403);
    const [row] = await database.db
      .select({ banned_at: accounts.banned_at })
      .from(accounts)
      .where(eq(accounts.id, 'player-1'));
    expect(row.banned_at).toBeNull();
    expect(revoked).toEqual([]);
  });

  it('同源校验：缺失或跨源的 Origin 一律拒绝', async () => {
    const withoutOrigin = await app.request('/api/admin/users/player-1/ban', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: null }),
    });
    expect(withoutOrigin.status).toBe(403);
    const foreignOrigin = await banRequest('player-1', { durationMs: null }, adminCookie, {
      origin: 'https://evil.example',
    });
    expect(foreignOrigin.status).toBe(403);
    expect(revoked).toEqual([]);
  });

  it('非法时长被 400 拒绝：零、负数、小数、越界、缺失与多余字段', async () => {
    for (const body of [
      { durationMs: 0 },
      { durationMs: -60_000 },
      { durationMs: 1.5 },
      { durationMs: MAX_BAN_DURATION_MS + 1 },
      { durationMs: Number.MAX_SAFE_INTEGER },
      {},
      { durationMs: null, forever: true },
    ]) {
      const response = await banRequest('player-1', body);
      expect(response.status).toBe(400);
    }
    const missingBody = await app.request('/api/admin/users/player-1/ban', {
      method: 'POST',
      headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    });
    expect(missingBody.status).toBe(400);
    expect(revoked).toEqual([]);
  });

  it('目标不存在返回 404，管理员目标返回 409，都不触及运行时', async () => {
    const missing = await banRequest('nobody-here', { durationMs: null });
    expect(missing.status).toBe(404);
    const adminTarget = await banRequest('admin-1', { durationMs: null });
    expect(adminTarget.status).toBe(409);
    expect(await errorOf(adminTarget)).toContain('管理员');
    expect(revoked).toEqual([]);
  });
});

describe('永久封禁', () => {
  it('下发后：会话保留身份并上报封禁，受保护接口全部拒绝，登出仍然可用', async () => {
    const response = await banRequest('player-1', { durationMs: null });
    expect(response.status).toBe(200);
    expect(((await response.json()) as BanIssued).ban).toEqual({ expiresAt: null });
    expect(revoked).toEqual(['player-1']);

    // 会话如实上报：身份与角色保留，界面据此提示永久封禁。
    expect(await sessionBody(player1Cookie)).toEqual({
      user: { id: 'player-1', username: '受罚学徒' },
      role: 'user',
      ban: { expiresAt: null },
    });

    // 受保护接口：永久封禁的统一提示。
    const profile = await gameRequest('GET', '/api/profile', player1Cookie);
    expect(profile.status).toBe(403);
    expect(await errorOf(profile)).toBe('该账号已被永久封禁。');

    const roomAttempt = await gameRequest('POST', '/api/rooms', player1Cookie, {
      'content-type': 'application/json',
      'X-Spelltype-Protocol': 'spelltype.v4',
    });
    expect(roomAttempt.status).toBe(403);
    const matchAttempt = await gameRequest('POST', '/api/match', player1Cookie, {
      'X-Spelltype-Protocol': 'spelltype.v4',
    });
    expect(matchAttempt.status).toBe(403);
    const cancelAttempt = await gameRequest('DELETE', '/api/match', player1Cookie, {
      'X-Spelltype-Protocol': 'spelltype.v4',
    });
    expect(cancelAttempt.status).toBe(403);
    const handshake = await app.request(`/api/rooms/${ROOM_ID}/ws`, {
      headers: {
        cookie: player1Cookie,
        origin: ORIGIN,
        upgrade: 'websocket',
        'sec-websocket-protocol': 'spelltype.v4',
      },
    });
    expect(handshake.status).toBe(403);

    // 登出仍被允许：封禁中的账户可以自行离开。
    const logout = await gameRequest('POST', '/api/logout', player1Cookie);
    expect(logout.status).toBe(200);

    // 管理端列表与详情都在响应时刻上报生效中的封禁。
    const list = (await (await adminRequest('/users?q=受罚')).json()) as AdminPage<AdminUser>;
    expect(list.items[0]).toMatchObject({ id: 'player-1', ban: { expiresAt: null } });
    const detail = (await (await adminRequest('/users/player-1')).json()) as AdminUserDetail;
    expect(detail.user.ban).toEqual({ expiresAt: null });
  });

  it('无法确认在线断开时以 503 收场，封禁本身保留且重新登录仍被允许', async () => {
    failRevocation = true;
    const response = await banRequest('player-1', { durationMs: null });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toContain('断开在线连接失败');
    // 封禁中的账户仍可登录（会话创建不受限），新会话立即只能读到封禁状态。
    const fresh = await createSession(database.db, 'player-1');
    expect(await sessionBody(`${SESSION_COOKIE}=${fresh.token}`)).toMatchObject({
      user: { id: 'player-1' },
      ban: { expiresAt: null },
    });
  });
});

describe('定时封禁与到期', () => {
  it('封禁约束在册的全部旧会话，重复下发整体覆盖，到期后自动解除', async () => {
    // 封禁前签发的旧会话：封禁针对账户，旧会话绝不是旁路。
    const oldCookie = `${SESSION_COOKIE}=${(await createSession(database.db, 'player-2')).token}`;

    const issuedAt = Date.now();
    const response = await banRequest('player-2', { durationMs: 60_000 });
    expect(response.status).toBe(200);
    const { ban } = (await response.json()) as BanIssued;
    expect(ban.expiresAt).toBeGreaterThanOrEqual(issuedAt + 59_000);
    expect(ban.expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(revoked).toEqual(['player-2']);

    // 旧会话只能读到封禁状态；受保护接口拒绝并说明到期时间。
    const reported = await sessionBody(oldCookie);
    expect(reported.user).toEqual({ id: 'player-2', username: '戴罪立功' });
    expect(reported.ban).toEqual({ expiresAt: ban.expiresAt });
    const profile = await gameRequest('GET', '/api/profile', oldCookie);
    expect(profile.status).toBe(403);
    expect(await errorOf(profile)).toContain('解封');

    // 重复下发整体覆盖：定时改永久，以最后一次操作为准。
    const overwrite = await banRequest('player-2', { durationMs: null });
    expect(((await overwrite.json()) as BanIssued).ban).toEqual({ expiresAt: null });
    expect(await sessionBody(oldCookie)).toMatchObject({ ban: { expiresAt: null } });

    // 到期即解除：无需任何清理任务，旧会话恢复全部权利。
    await database.db
      .update(accounts)
      .set({ ban_expires_at: Date.now() - 1 })
      .where(eq(accounts.id, 'player-2'));
    expect(await sessionBody(oldCookie)).toEqual({
      user: { id: 'player-2', username: '戴罪立功' },
      role: 'user',
      ban: null,
    });
    expect((await gameRequest('GET', '/api/profile', oldCookie)).status).toBe(200);

    // 过期的定时封禁在管理端读取为未封禁：ban 是响应时刻的生效状态。
    const list = (await (await adminRequest('/users?q=戴罪')).json()) as AdminPage<AdminUser>;
    expect(list.items[0]).toMatchObject({ id: 'player-2', ban: null });
  });

  it('运行时缺席时端点以 503 收场，封禁仍已提交且新会话如实上报', async () => {
    const orphanApp = createApp({ database: database.db, config, rooms: null });
    const response = await orphanApp.request('/api/admin/users/player-2/ban', {
      method: 'POST',
      headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: null }),
    });
    expect(response.status).toBe(503);

    // 封禁中的账户仍可登录（会话创建不受限），新会话立即只能读到封禁状态。
    const fresh = await createSession(database.db, 'player-2');
    expect(await sessionBody(`${SESSION_COOKIE}=${fresh.token}`)).toMatchObject({
      user: { id: 'player-2' },
      ban: { expiresAt: null },
    });
  });
});

describe('真实运行时的封禁裁决', () => {
  it('authorizeSocket 以数据库为权威拒绝已封禁账户，未封禁账户照常通过', async () => {
    const runtimeDb = await openDatabase('pglite://:memory:');
    try {
      const now = Date.now();
      await runtimeDb.db.insert(accounts).values([
        {
          id: 'sealed',
          username: '已封者',
          role: 'user',
          wechat_identity: 'union:sealed',
          created_at: now,
          banned_at: now,
          ban_expires_at: null,
        },
        {
          id: 'free',
          username: '自由人',
          role: 'user',
          wechat_identity: 'union:free',
          created_at: now,
        },
      ]);
      const sealedSession = await createSession(runtimeDb.db, 'sealed');
      const freeSession = await createSession(runtimeDb.db, 'free');
      await createRoom(runtimeDb.db, {
        id: ROOM_ID,
        host: { id: 'free', username: '自由人' },
        theme: '封禁裁决',
        mode: 'private',
      });
      const runtime = await createRoomRuntime({
        database: runtimeDb.db,
        inputPolicyMode: 'observe',
        generate: async () => {
          throw new Error('封禁测试不生成咒文');
        },
      });
      try {
        // 会话对象仍携带 ban: null（封禁提交前的旧读取）：数据库重查才是权威。
        await rejects(
          runtime.authorizeSocket(ROOM_ID, {
            user: { id: 'sealed', username: '已封者' },
            role: 'user',
            tokenHash: hashToken(sealedSession.token),
            expiresAt: sealedSession.expiresAt,
            ban: null,
          }),
          { code: 'room:unauthenticated', status: 403 },
        );
        await runtime.authorizeSocket(ROOM_ID, {
          user: { id: 'free', username: '自由人' },
          role: 'user',
          tokenHash: hashToken(freeSession.token),
          expiresAt: freeSession.expiresAt,
          ban: null,
        });
        // 无在线连接的账户撤销是平凡成功。
        await runtime.revokeUser('nobody-attached');
      } finally {
        await runtime.close();
      }
    } finally {
      await runtimeDb.close();
    }
  });
});
