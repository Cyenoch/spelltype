import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { z } from 'zod';
import { MAX_API_BODY_BYTES } from '../../shared/protocol';
import type { ActivitySummary, MatchResult, Profile, SessionInfo } from '../../shared/protocol';
import {
  createRoomSchema,
  loginSchema,
  registerSchema,
  roomIdSchema,
  type LoginInput,
} from '../../shared/validation';
import { readActivitySummary } from '../activity';
import {
  SESSION_COOKIE,
  createSession,
  hashPassword,
  loadSession,
  revokeSession,
  sessionHashFromToken,
  unknownAccountHash,
  verifyPassword,
  type ActiveSession,
  type SessionTicket,
} from '../auth/sessions';
import type { Env } from '../env';
import { newRoomId, userShardName } from '../ids';

type ApiEnv = { Bindings: Env; Variables: { session: ActiveSession } };

/** Errors are logged as text only: never request bodies, credentials or provider payloads. */
function errorText(error: unknown, maxLength = 200): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

/**
 * The same-origin gate for every state change and the WebSocket handshake: the header must be the
 * canonical origin of the request itself. A missing or opaque origin, a foreign site, another scheme
 * or port, and any value that is not exactly an origin are all refused.
 *
 * Hono's `csrf` cannot stand in for this one: it only inspects form-shaped requests, and never a
 * WebSocket handshake.
 */
const sameOrigin = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.req.header('origin') !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: '请求来源不受信任' });
  }
  await next();
});

/**
 * Counts every authentication attempt before any password hashing, so an unauthenticated caller
 * cannot spend the isolate's CPU on KDF work. `env.AUTH_LIMITER` is the platform rate-limit binding.
 */
const rateLimit = (scope: 'register' | 'login') =>
  createMiddleware<ApiEnv>(async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    try {
      const { success } = await c.env.AUTH_LIMITER.limit({ key: `${scope}:${ip}` });
      if (!success) throw new HTTPException(429, { message: '尝试次数过多，请稍后再试' });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      // A limiter outage must not lock players out of their own accounts.
      console.error(`auth limiter unavailable: ${errorText(error)}`);
    }
    await next();
  });

/** The session the presented cookie stands for, or the API's 401. */
async function authenticate(env: Env, cookie: string | undefined): Promise<ActiveSession> {
  const session = await loadSession(env, sessionHashFromToken(cookie));
  if (!session) throw new HTTPException(401, { message: '登录状态已失效，请重新登录' });
  return session;
}

const authenticated = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('session', await authenticate(c.env, getCookie(c, SESSION_COOKIE)));
  await next();
});

/**
 * Login credentials are read leniently on purpose: a shape the KDF cannot use must still reach the
 * KDF and come back as the same 401 as a wrong password, never as a validation error.
 */
const loginBody = createMiddleware<
  ApiEnv,
  string,
  { in: { json: LoginInput }; out: { json: { credentials: LoginInput | null } } }
>(async (c, next) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  c.req.addValidatedData('json', { credentials: parsed.success ? parsed.data : null });
  await next();
});

/** `Secure` is only set on HTTPS, so local HTTP development keeps working. */
function issueSessionCookie(c: Context<ApiEnv>, ticket: SessionTicket, now = Date.now()): void {
  setCookie(c, SESSION_COOKIE, ticket.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: Math.max(0, Math.floor((ticket.expiresAt - now) / 1000)),
  });
}

// RPC reconstructs errors, so validate serializable fields rather than class identity.
const rpcRejectionSchema = z.object({
  code: z.string(),
  status: z.literal([403, 404, 409]),
  userMessage: z.string(),
});

function mapRoomError(error: unknown): HTTPException {
  const rejection = rpcRejectionSchema.safeParse(error);
  if (rejection.success)
    return new HTTPException(rejection.data.status, { message: rejection.data.userMessage });
  console.error(`room rpc failed: ${errorText(error)}`);
  return new HTTPException(500, { message: '房间暂时不可用' });
}

function mapMatchError(error: unknown): HTTPException {
  const rejection = rpcRejectionSchema.safeParse(error);
  if (rejection.success)
    return new HTTPException(rejection.data.status, { message: rejection.data.userMessage });
  console.error(`matchmaker failed: ${errorText(error)}`);
  return new HTTPException(503, { message: '匹配服务暂时不可用，请稍后再试' });
}

const app = new Hono<ApiEnv>({ strict: false });
// One cap for every API body, not per route, and first in the chain: an oversized body is cut before
// any other gate reads it, and no route can be added later that forgets the cap.
app.use(
  '/api/*',
  bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => c.json({ error: '请求内容过大' }, 413),
  }),
);
app.use('/api/*', async (c, next) => {
  await next();
  // Never reconstruct an upgraded response: it owns the Durable Object WebSocket.
  if (c.res.status !== 101) c.res.headers.set('cache-control', 'no-store');
});
app.use(
  '*',
  methodNotAllowed({
    app,
    onMethodNotAllowed: (c, methods) =>
      c.json({ error: '请求方法不被支持' }, 405, { Allow: methods.join(', ') }),
  }),
);
app.use('/api/rooms/:roomId/*', async (c, next) => {
  if (!roomIdSchema.safeParse(c.req.param('roomId')).success)
    throw new HTTPException(404, { message: '房间不存在' });
  await next();
});
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(`api ${c.req.method} ${c.req.path} failed: ${errorText(error)}`);
  return c.json({ error: '服务器内部错误' }, 500);
});
app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json({ error: '接口不存在' }, 404)
    : c.env.ASSETS.fetch(c.req.raw),
);

const routes = app
  .get('/api/session', async (c) => {
    const session = await loadSession(c.env, sessionHashFromToken(getCookie(c, SESSION_COOKIE)));
    const body: SessionInfo = {
      user: session?.user ?? null,
      aiConfigured: Boolean(c.env.DEEPSEEK_API_KEY?.trim()),
    };
    return c.json(body);
  })
  .get('/api/activity', async (c) => {
    let activity: ActivitySummary;
    try {
      activity = await readActivitySummary(c.env);
    } catch (error) {
      // An unavailable answer stays unavailable: no probe is silently counted as idle.
      console.error(`activity summary failed: ${errorText(error)}`);
      throw new HTTPException(503, { message: '活动数据暂时不可用，请稍后再试。' });
    }
    return c.json(activity);
  })
  .post(
    '/api/register',
    sameOrigin,
    rateLimit('register'),
    zValidator('json', registerSchema, (result) => {
      if (!result.success)
        throw new HTTPException(400, {
          message: result.error.issues.map((issue) => issue.message).join('；'),
        });
    }),
    async (c) => {
      const { username, password } = c.req.valid('json');
      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      try {
        await c.env.DB.prepare(
          'INSERT INTO accounts (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(id, username, username.toLowerCase(), passwordHash, Date.now())
          .run();
      } catch (error) {
        const message = errorText(error);
        if (message.includes('UNIQUE') || message.includes('constraint failed'))
          throw new HTTPException(409, { message: '该用户名已被使用' });
        throw error;
      }
      issueSessionCookie(c, await createSession(c.env, id));
      return c.json({ user: { id, username } });
    },
  )
  .post('/api/login', sameOrigin, rateLimit('login'), loginBody, async (c) => {
    const { credentials } = c.req.valid('json');
    const account = credentials
      ? await c.env.DB.prepare(
          'SELECT id, username, password_hash FROM accounts WHERE username_key = ?',
        )
          .bind(credentials.username.toLowerCase())
          .first<{ id: string; username: string; password_hash: string }>()
      : null;
    const stored = account ? account.password_hash : await unknownAccountHash();
    const verified = await verifyPassword(credentials?.password ?? '', stored);
    if (!account || !credentials || !verified)
      throw new HTTPException(401, { message: '用户名或密码不正确' });
    issueSessionCookie(c, await createSession(c.env, account.id));
    return c.json({ user: { id: account.id, username: account.username } });
  })
  .post('/api/logout', sameOrigin, async (c) => {
    // Revoke even tombstoned sessions. Do not clear the cookie if a room refuses revocation.
    const tokenHash = sessionHashFromToken(getCookie(c, SESSION_COOKIE));
    if (tokenHash) await revokeSession(c.env, tokenHash);
    deleteCookie(c, SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure: new URL(c.req.url).protocol === 'https:',
    });
    return c.json({ ok: true as const });
  })
  .get('/api/profile', authenticated, async (c) => {
    const user = c.var.session.user;
    const stats = await c.env.DB.prepare(
      'SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END), 0) AS wins, COALESCE(MAX(cpm), 0) AS bestCpm FROM results WHERE user_id = ?',
    )
      .bind(user.id)
      .first<{ games: number; wins: number; bestCpm: number }>();
    const history = await c.env.DB.prepare(
      'SELECT match_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms, rank, cpm, accuracy, created_at FROM results WHERE user_id = ? ORDER BY created_at DESC, match_id DESC LIMIT 10',
    )
      .bind(user.id)
      .all<MatchResult>();
    const body: Profile = {
      user,
      stats: { games: stats?.games ?? 0, wins: stats?.wins ?? 0, bestCpm: stats?.bestCpm ?? 0 },
      history: history.results ?? [],
    };
    return c.json(body);
  })
  .post(
    '/api/rooms',
    sameOrigin,
    authenticated,
    zValidator('json', createRoomSchema, (result) => {
      if (!result.success)
        throw new HTTPException(400, {
          message: result.error.issues.map((issue) => issue.message).join('；'),
        });
    }),
    async (c) => {
      const { theme } = c.req.valid('json');
      const roomId = newRoomId();
      try {
        await c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId)).initialize({
          id: roomId,
          host: c.var.session.user,
          theme,
          mode: 'private',
        });
      } catch (error) {
        throw mapRoomError(error);
      }
      return c.json({ roomId });
    },
  )
  .get('/api/rooms/:roomId', authenticated, async (c) => {
    const roomId = c.req.param('roomId');
    try {
      return c.json(
        await c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId)).snapshot(c.var.session.user),
      );
    } catch (error) {
      throw mapRoomError(error);
    }
  })
  .post('/api/rooms/:roomId/leave', sameOrigin, authenticated, async (c) => {
    const roomId = c.req.param('roomId');
    try {
      // No body: the session's account is the only subject. The room commits the
      // departure durably before answering, so `left` is never sent on a failure.
      await c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId)).leaveRoom(c.var.session.user.id);
    } catch (error) {
      throw mapRoomError(error);
    }
    return c.json({ left: true as const });
  })
  .get('/api/rooms/:roomId/ws', sameOrigin, async (c) => {
    const request = c.req.raw;
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      throw new HTTPException(426, { message: '需要 WebSocket 升级请求' });
    const session = await authenticate(c.env, getCookie(c, SESSION_COOKIE));
    const roomId = c.req.param('roomId');
    const headers = new Headers({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'x-user-id': session.user.id,
      'x-username': encodeURIComponent(session.user.username),
      'x-session-hash': session.tokenHash,
      'x-session-expires': String(session.expiresAt),
      'x-room-id': roomId,
    });
    request.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith('sec-websocket-')) headers.set(name, value);
    });
    const url = new URL(request.url);
    try {
      return await c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId)).fetch(
        new Request(new URL(url.pathname, url.origin), { method: 'GET', headers }),
      );
    } catch (error) {
      throw mapRoomError(error);
    }
  })
  .post('/api/match', sameOrigin, authenticated, async (c) => {
    const user = c.var.session.user;
    const shard = c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName(userShardName(user.id)));
    try {
      return c.json(await shard.acquire(user));
    } catch (error) {
      throw mapMatchError(error);
    }
  })
  .delete('/api/match', sameOrigin, authenticated, async (c) => {
    const user = c.var.session.user;
    const shard = c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName(userShardName(user.id)));
    try {
      return c.json(await shard.cancel(user.id));
    } catch (error) {
      throw mapMatchError(error);
    }
  });

export type AppType = typeof routes;
export default app;
