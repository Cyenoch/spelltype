/**
 * Account and session input boundaries — the checks that run before any database write.
 *
 * Username, password and theme narrowing live in `shared/validation.ts`, which the routes and the
 * forms both parse, so those rules are read straight off the schemas. The stored KDF record and
 * the session cookie are pinned against the real app over a real PGlite database: a mistake in
 * either is an account takeover or a session that dies on the next request.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  SESSION_TTL_MS,
  USERNAME_MAX_CHARS,
} from '../../shared/protocol';
import { DEV_RELEASE_ID } from '../../shared/release';
import { loginPasswordSchema, passwordSchema, usernameSchema } from '../../shared/validation';
import {
  hashPassword,
  hashToken,
  sessionHashFromToken,
  SESSION_COOKIE,
  verifyPassword,
} from '../../server/auth/sessions';
import type { ServerConfig } from '../../server/config';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import { accounts, sessions } from '../../server/db/schema';
import { createStableApp } from '../../server/http/app';
import { parsedString, rejected } from '../support/schema-probe';

const ORIGIN = 'https://app.example';
const INSECURE_ORIGIN = 'http://app.example';

let database: OpenedDatabase;

describe('账号与会话边界', () => {
  afterEach(async () => {
    // 每个用例从干净表开始；连接保留到整个文件结束。纯 schema 用例不打开数据库。
    if (database) {
      await database.db.delete(sessions);
      await database.db.delete(accounts);
    }
  });

  /** Registers over `origin`, the only thing that decides whether the cookie is marked `Secure`. */
  async function register(
    app: HonoLike,
    origin: string,
    body = { username: '　咒文使　', password: 'correct horse battery' },
  ): Promise<Response> {
    return app.request('/api/register', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function sessionCookie(response: Response): string {
    const header = response.headers.get('set-cookie') ?? '';
    return header.slice(`${SESSION_COOKIE}=`.length).split(';')[0];
  }

  describe('用户名', () => {
    it('按 NFKC 折叠并裁剪首尾空白，长度按码点计数，字符集之外一律拒绝', () => {
      expect(parsedString(usernameSchema, '　ＡＢ　')).toBe('AB');
      expect(parsedString(usernameSchema, 'Wizard_1')).toBe('Wizard_1');
      expect(parsedString(usernameSchema, '咒文使')).toBe('咒文使');
      expect(parsedString(usernameSchema, 'ab')).toBe('ab');
      expect(parsedString(usernameSchema, 'a'.repeat(USERNAME_MAX_CHARS))).toBe(
        'a'.repeat(USERNAME_MAX_CHARS),
      );
      for (const value of [
        'a',
        'a'.repeat(USERNAME_MAX_CHARS + 1),
        '',
        '   ',
        'a b',
        'a-b',
        '😀',
        '咒\n文',
        42,
        null,
        {},
      ]) {
        expect(rejected(usernameSchema, value), JSON.stringify(value)).toBe(true);
      }
    });
  });

  describe('密码', () => {
    it('注册只校验长度并原样返回，登录只要求非空且不过长：密码从不做归一化或裁剪', () => {
      expect(parsedString(passwordSchema, '  spaced  ')).toBe('  spaced  ');
      expect(parsedString(passwordSchema, 'x'.repeat(PASSWORD_MIN_CHARS))).not.toBeNull();
      expect(parsedString(passwordSchema, 'x'.repeat(PASSWORD_MAX_CHARS))).not.toBeNull();
      expect(rejected(passwordSchema, 'x'.repeat(PASSWORD_MIN_CHARS - 1))).toBe(true);
      expect(rejected(passwordSchema, 'x'.repeat(PASSWORD_MAX_CHARS + 1))).toBe(true);
      expect(rejected(passwordSchema, 1234567890)).toBe(true);

      // 已有账号的短密码也必须能送到服务端校验，否则登录会在客户端被挡住。
      expect(parsedString(loginPasswordSchema, 'short')).toBe('short');
      expect(rejected(loginPasswordSchema, '')).toBe(true);
      expect(rejected(loginPasswordSchema, 'x'.repeat(PASSWORD_MAX_CHARS + 1))).toBe(true);
    });
  });

  describe('口令 KDF 记录', () => {
    it('同一口令的两次散列不同且都能验证，错误口令与越界或损坏的记录被拒绝', async () => {
      const first = await hashPassword('correct horse battery');
      const second = await hashPassword('correct horse battery');
      expect(first).not.toBe(second);
      // PHC 记录：argon2id，OWASP 参考参数 m=19456 KiB、t=2。
      expect(first).toMatch(
        /^\$argon2id\$v=\d+\$m=19456,t=2,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
      );
      expect(await verifyPassword('correct horse battery', first)).toBe(true);
      expect(await verifyPassword('correct horse battery', second)).toBe(true);
      expect(await verifyPassword('correct horse batterz', first)).toBe(false);
      expect(await verifyPassword('correct horse battery', 'not-a-hash')).toBe(false);
      // 越界的成本参数来自被篡改的行：拒绝而不是照单执行。
      const [, , , cost, salt, key] = first.split('$');
      expect(
        await verifyPassword('anything-at-all', `$argon2id$v=19$m=99999999,t=2,p=1$${salt}$${key}`),
      ).toBe(false);
      expect(await verifyPassword('anything-at-all', `$argon2id$v=19$${cost}$$`)).toBe(false);
      expect(cost).toBe('m=19456,t=2,p=1');
    });
  });

  describe('会话 Cookie', () => {
    it('注册下发的 Cookie 携带会话令牌，属性齐全，HTTP 公网源下不带 Secure', async () => {
      const app = await testApp(INSECURE_ORIGIN);
      const response = await register(app, INSECURE_ORIGIN);
      expect(response.status).toBe(200);
      // 用户名按规范化后的形状落到账号上。
      expect(await response.json()).toEqual({
        user: { id: expect.any(String), username: '咒文使' },
      });

      const header = response.headers.get('set-cookie') ?? '';
      expect(header).toContain(`${SESSION_COOKIE}=`);
      expect(header).toContain('Path=/');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
      expect(header).not.toContain('Secure');

      // 下发的令牌必须正是会话读取端接受的形状，否则注册完刷新就掉线。
      const token = sessionCookie(response);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sessionHashFromToken(token)).toBe(hashToken(token));
    });

    it('HTTPS 公网源下同一 Cookie 带 Secure', async () => {
      const app = await testApp(ORIGIN);
      const response = await register(app, ORIGIN);
      expect(response.status).toBe(200);
      expect(sessionCookie(response).length).toBeGreaterThan(0);
      expect(response.headers.get('set-cookie') ?? '').toContain('Secure');
    });

    it('登出清空 Cookie，且带相同的作用域属性', async () => {
      const app = await testApp(ORIGIN);
      const response = await app.request('/api/logout', {
        method: 'POST',
        headers: { origin: ORIGIN },
      });
      expect(response.status).toBe(200);
      const header = response.headers.get('set-cookie') ?? '';
      expect(header).toContain(`${SESSION_COOKIE}=;`);
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('Path=/');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Secure');
    });

    it('注册真正落库：规范化的用户名可登录，重复注册被唯一约束拒绝为 409', async () => {
      const app = await testApp(ORIGIN);
      const first = await register(app, ORIGIN);
      expect(first.status).toBe(200);

      const login = await app.request('/api/login', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ username: '咒文使', password: 'correct horse battery' }),
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({
        user: { id: expect.any(String), username: '咒文使' },
      });

      const duplicate = await register(app, ORIGIN);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: '该用户名已被使用' });

      // 规范化前的同形用户名同样命中唯一约束，而不是注册出第二个账号。
      const aliased = await register(app, ORIGIN, {
        username: '咒文使',
        password: 'correct horse battery',
      });
      expect(aliased.status).toBe(409);
    });

    it('密码从不落明文：库里只有可验证的 KDF 记录', async () => {
      const app = await testApp(ORIGIN);
      await register(app, ORIGIN);
      const [row] = await database.db
        .select({ passwordHash: accounts.password_hash })
        .from(accounts)
        .where(and(eq(accounts.username_key, '咒文使')));
      expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(row?.passwordHash.includes('correct horse')).toBe(false);
    });
  });
});

/** Minimal structural view of a Hono app the helpers issue requests against. */
interface HonoLike {
  request(input: string, init?: RequestInit): Promise<Response>;
}

async function testApp(publicOrigin: string): Promise<HonoLike> {
  const config: ServerConfig = {
    role: 'all',
    releaseId: DEV_RELEASE_ID,
    databaseUrl: 'pglite://:memory:',
    hostname: '127.0.0.1',
    port: 0,
    adminPort: null,
    publicOrigin,
    adminToken: null,
    assetsRoot: null,
    ai: { apiKey: null, model: 'test-model' },
    authLimits: { attempts: 100, windowMs: 60_000 },
    trustForwardedFor: false,
    matchAdmission: 'open',
    inputPolicyMode: 'observe',
  };
  database ??= await openDatabase('pglite://:memory:');
  const app = createStableApp({ database: database.db, config, rooms: null });
  return app as unknown as HonoLike;
}
