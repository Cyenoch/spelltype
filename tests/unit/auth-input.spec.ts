/**
 * Account and session input boundaries — the checks that run before any D1 write.
 *
 * Username, password and theme narrowing live in `shared/validation.ts`, which the routes and the
 * forms both parse, so those rules are read straight off the schemas. The stored KDF record and the
 * session cookie are pinned against the real app and the real Hono cookie helpers: a mistake in
 * either is an account takeover or a session that dies on the next request.
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  SESSION_TTL_MS,
  USERNAME_MAX_CHARS,
} from '../../shared/protocol';
import { loginPasswordSchema, passwordSchema, usernameSchema } from '../../shared/validation';
import app from '../../worker/http/app';
import {
  SESSION_COOKIE,
  hashPassword,
  hashToken,
  sessionHashFromToken,
  verifyPassword,
} from '../../worker/auth/sessions';
import type { Env } from '../../worker/env';
import { parsedString, rejected } from '../support/schema-probe';

/** Only the bindings a registration reaches: both inserts are accepted, nothing is read back. */
const env = {
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
} as unknown as Env;

/** Registers over `scheme`, the only thing that decides whether the cookie is marked `Secure`. */
async function register(scheme: 'http' | 'https'): Promise<Response> {
  return app.request(
    `${scheme}://app.example/api/register`,
    {
      method: 'POST',
      headers: { origin: `${scheme}://app.example`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: '　咒文使　', password: 'correct horse battery' }),
    },
    env,
  );
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
    await expect(verifyPassword('correct horse battery', first)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery', second)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', first)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery', 'not-a-hash')).resolves.toBe(false);
    // 越界的成本参数来自被篡改的行：拒绝而不是照单执行。
    const [, version, , salt, key] = first.split('$');
    await expect(
      verifyPassword('anything-at-all', `scrypt$${version}$N=1,r=8,p=3$${salt}$${key}`),
    ).resolves.toBe(false);
  });
});

describe('会话 Cookie', () => {
  it('注册下发的 Cookie 携带会话令牌，属性齐全，HTTP 下不带 Secure', async () => {
    const response = await register('http');
    expect(response.status).toBe(200);
    // 用户名按规范化后的形状落到账号上。
    await expect(response.json()).resolves.toEqual({
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

  it('HTTPS 下同一 Cookie 带 Secure', async () => {
    const response = await register('https');
    expect(response.status).toBe(200);
    expect(sessionCookie(response).length).toBeGreaterThan(0);
    expect(response.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  it('登出清空 Cookie，且带相同的作用域属性', async () => {
    const response = await app.request(
      'https://app.example/api/logout',
      { method: 'POST', headers: { origin: 'https://app.example' } },
      env,
    );
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Secure');
  });

  it('只有形状正确的令牌才算会话摘要，缺失或损坏的 Cookie 都不是会话', () => {
    const token = 'a'.repeat(43);
    expect(sessionHashFromToken(token)).toBe(hashToken(token));
    for (const value of [
      undefined,
      '',
      'short',
      'a'.repeat(44),
      'a'.repeat(42),
      `${'a'.repeat(42)}.`,
      `${'a'.repeat(41)}%%`,
    ]) {
      expect(sessionHashFromToken(value), String(value)).toBeNull();
    }
  });
});
