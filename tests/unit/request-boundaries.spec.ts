/**
 * Request input boundaries — the gates every state change, WebSocket handshake and JSON body passes
 * through.
 *
 * Every case is driven through the real Hono app (`worker/http/app.ts`), so what is pinned is the
 * behaviour of the migrated boundary itself: the same-origin gate on state changes and WebSocket
 * handshakes, the body cap (which must cut an oversized stream, not buffer it), the narrowing of
 * untrusted request values, native method/route handling, and the JSON body contract.
 *
 * The stub env exposes only what these gates can reach before any real resource does: a rejected
 * request must never need D1, a rate limiter or a Durable Object.
 */
import { describe, expect, it } from 'vitest';
import app from '../../worker/http/app';
import type { Env } from '../../worker/env';
import { MAX_API_BODY_BYTES, MAX_THEME_CHARS } from '../../shared/protocol';
import { difficultySchema, themeSchema } from '../../shared/validation';
import { parsedString, rejected } from '../support/schema-probe';

const ORIGIN = 'https://app.example';
const ROOM_ID = '0123456789abcdef01234567';

const env = {
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
  ASSETS: { fetch: async () => new Response('assets') },
} as unknown as Env;

/** Shaped after the real `fetch` request the browser makes. */
async function call(
  method: string,
  path: string,
  options: { origin?: string | null; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return app.request(`${ORIGIN}${path}`, { method, headers, body: options.body }, env);
}

/** A register body of exactly `size` bytes whose password is too short for the schema. */
function exactBody(size: number): string {
  const budget = size - JSON.stringify({ username: 'ab', password: 'x', pad: '' }).length;
  const encoded = JSON.stringify({ username: 'ab', password: 'x', pad: 'x'.repeat(budget) });
  if (new TextEncoder().encode(encoded).byteLength !== size)
    throw new Error(`cannot build a body of exactly ${size} bytes`);
  return encoded;
}

const STATE_CHANGES = [
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
  {
    method: 'POST',
    path: '/api/rooms',
    body: JSON.stringify({ theme: '咒文契约', difficulty: 'easy' }),
  },
  { method: 'POST', path: '/api/match', body: JSON.stringify({ difficulty: 'easy' }) },
  { method: 'DELETE', path: '/api/match' },
  { method: 'GET', path: `/api/rooms/${ROOM_ID}/ws` },
];

describe('同源校验', () => {
  it('每一个状态变更与房间 WebSocket 握手都要求规范来源', async () => {
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
    for (const { method, path, body } of STATE_CHANGES) {
      for (const origin of hostile) {
        const response = await call(method, path, { origin, body });
        expect(response.status, `${method} ${path} origin=${origin}`).toBe(403);
      }
    }
  });

  it('拒绝时返回统一的 JSON 错误体，且不被缓存', async () => {
    const response = await call('POST', '/api/logout', { origin: 'https://evil.example' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: '请求来源不受信任' });
  });

  it('规范来源能通过该闸门，走到各自的下一个判定', async () => {
    // 无会话的登出没有可吊销的内容：闸门放行后即成功。
    await expect((await call('POST', '/api/logout')).json()).resolves.toEqual({ ok: true });

    // 注册到达 schema：用户名的长度判定，而不是来源判定。
    const shortUsername = await call('POST', '/api/register', {
      body: JSON.stringify({ username: 'a', password: 'correct horse' }),
    });
    expect(shortUsername.status).toBe(400);

    // 带会话的接口到达鉴权：无 Cookie 即 401。
    expect(
      (await call('POST', '/api/match', { body: JSON.stringify({ difficulty: 'easy' }) })).status,
    ).toBe(401);

    // 房间握手到达升级判定：普通 GET 即 426。
    expect((await call('GET', `/api/rooms/${ROOM_ID}/ws`)).status).toBe(426);
  });
});

describe('房间号', () => {
  it('形状不对的房间号在进入房间流程之前就被拒绝', async () => {
    const response = await call('GET', '/api/rooms/not-a-room-id/ws');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '房间不存在' });
  });
});

describe('请求体上限', () => {
  it('声明超限与流式超限都被截断为 413', async () => {
    const declared = await call('POST', '/api/register', {
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
      headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ error: '请求内容过大' });

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
    const chunked = await app.request(
      `${ORIGIN}/api/register`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit,
      env,
    );
    expect(chunked.status).toBe(413);
  });

  it('无长度声明的分块请求体在上限内照常解析', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ username: 'a', password: 'correct horse' })),
        );
        controller.close();
      },
    });
    const response = await app.request(
      `${ORIGIN}/api/register`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit,
      env,
    );
    // 上限内的分块请求体同样被读入并交给 schema：这是用户名的 400。
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('用户名'),
    });
  });

  it('恰好等于上限的请求体不被截断，而是照常解析并校验', async () => {
    const body = exactBody(MAX_API_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_API_BODY_BYTES);

    const response = await call('POST', '/api/register', { body });
    // 请求体真的被读入并交给了 schema：这是密码长度的 400，而不是上限的 413。
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('密码至少'),
    });
  });
});

describe('JSON 请求体', () => {
  it('非法 JSON、空体、非对象与错误形状都是 400 且带 JSON 错误体', async () => {
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
      const response = await call('POST', '/api/register', { body });
      expect(response.status, body || 'empty').toBe(400);
      const payload = (await response.json()) as { error?: unknown };
      expect(typeof payload.error, body || 'empty').toBe('string');
      expect((payload.error as string).length, body || 'empty').toBeGreaterThan(0);
    }
  });

  it('非 JSON 的 Content-Type 不能绕过校验', async () => {
    const response = await call('POST', '/api/register', {
      body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(400);
  });

  it('登录的形状错误不构成账号预言：与错误口令一样是 401', async () => {
    for (const body of ['{oops', '', '[]', '{}']) {
      const response = await call('POST', '/api/login', { body });
      expect(response.status, body || 'empty').toBe(401);
      await expect(response.json()).resolves.toEqual({ error: '用户名或密码不正确' });
    }
  });

  it('未预期的故障是 500 JSON，不泄露内部信息', async () => {
    const failing = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('d1 down: SELECT secret');
        },
      },
    } as unknown as Env;
    const response = await app.request(
      `${ORIGIN}/api/register`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ab', password: 'correct horse' }),
      },
      failing,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '服务器内部错误' });
  });
});

describe('方法与路径', () => {
  it('已知路径上不支持的方法返回 405，并声明允许的方法', async () => {
    for (const [method, path, allowed] of [
      ['PUT', '/api/session', ['GET', 'HEAD']],
      ['POST', '/api/session', ['GET', 'HEAD']],
      ['DELETE', '/api/register', ['POST']],
      ['POST', `/api/rooms/${ROOM_ID}/ws`, ['GET', 'HEAD']],
      ['GET', '/api/match', ['POST', 'DELETE']],
    ] as const) {
      const response = await call(method, path);
      expect(response.status, `${method} ${path}`).toBe(405);
      const allow = (response.headers.get('allow') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      expect(allow.sort(), `${method} ${path}`).toEqual(Array.from(allowed).sort());
      await expect(response.json()).resolves.toEqual({ error: '请求方法不被支持' });
    }
  });

  it('未知接口是 404，未知方法也不例外；非接口路径交给静态资源', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await call(method, '/api/unknown');
      expect(response.status, method).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: '接口不存在' });
    }
    const page = await call('GET', '/lobby/abc');
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toBe('assets');
  });
});

describe('请求取值', () => {
  it('难度只接受协议内的三个取值，主题裁剪空白并按码点限制长度', () => {
    expect(parsedString(difficultySchema, 'easy')).toBe('easy');
    for (const value of ['Easy', ' hard ', '', 'expert', 1, null, undefined]) {
      expect(rejected(difficultySchema, value), String(value)).toBe(true);
    }

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
