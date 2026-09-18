import { zValidator } from '@hono/zod-validator';
import type { Server } from 'bun';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MAX_API_BODY_BYTES,
  WS_PROTOCOL,
  type ActivitySummary,
  type Profile,
  type SessionInfo,
} from '../../shared/protocol';
import {
  ReleaseError,
  releaseIdSchema,
  gameApiBase,
  type ReleaseInfo,
  type RoomLocation,
} from '../../shared/release';
import {
  createRoomSchema,
  loginSchema,
  registerSchema,
  roomIdSchema,
} from '../../shared/validation';
import type { LoginInput } from '../../shared/validation';
import {
  SESSION_COOKIE,
  createSession,
  hashPassword,
  loadSession,
  secretsEqual,
  sessionHashFromToken,
  unknownAccountHash,
  verifyPassword,
  type SessionTicket,
} from '../auth/sessions';
import {
  ReleaseConflict,
  activateRelease,
  checkRelease,
  completeRetirement,
  getReleaseInfo,
  probeRetirement,
  stageRelease,
  withAdmission,
  type RuntimeHealth,
} from '../releases/control';
import { acquireMatch, cancelMatch, newRoomId } from '../matchmaking';
import { createRoom } from '../rooms/storage/room';
import { readActivitySummary } from '../activity';
import type {
  AuthenticatedSession,
  ReleaseProbe,
  RoomRuntimePort,
  RoomSocketData,
  ServerServices,
} from '../contracts';
import type { Database, QueryDatabase } from '../db';
import { accounts, releaseControl, releaseVersions, results, rooms } from '../db/schema';
import {
  authRateLimits,
  createAuthRateLimiter,
  rateLimitKey,
  type AuthRateLimiter,
} from './rate-limit';
import { revokeSessionEverywhere } from './revocation';

/**
 * The public HTTP surface: the stable identity/lobby app, the per-release game app Main mounts at
 * exactly `/api/releases/<config.releaseId>`, and the loopback admin app. Every boundary reads the
 * server's own configuration and the database — no platform bindings exist anywhere.
 *
 * `HttpEnv` is exported so the composition root mounts these apps without losing the typed chain.
 */
export type HttpEnv = {
  Bindings: { server?: Server<RoomSocketData> };
  Variables: {
    services: ServerServices;
    session: AuthenticatedSession;
    limiter: AuthRateLimiter;
    releaseProbe?: ReleaseProbe;
  };
};

/** Any of the three apps above, as the composition root receives them. */
export type ServerApp = Hono<HttpEnv>;

/** Errors are logged as text only: never request bodies, credentials or provider payloads. */
function errorText(error: unknown, maxLength = 200): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

/**
 * The admission pointer, read only to decorate release rejections with the version a stale client
 * should move to. Admission itself is enforced inside `withAdmission` on every resource creation.
 */
async function activeReleasePointer(database: QueryDatabase): Promise<string | null> {
  const [control] = await database
    .select({ activeReleaseId: releaseControl.active_release_id })
    .from(releaseControl);
  return control?.activeReleaseId ?? null;
}

/**
 * The same-origin gate for every state change and the WebSocket handshake: the header must be the
 * configured public origin of this deployment. A missing or opaque origin, a foreign site, another
 * scheme or port, and any value that is not exactly that origin are all refused. Client-provided
 * proxy headers play no part: the expected origin comes from the server's own configuration.
 *
 * Hono's `csrf` cannot stand in for this one: it only inspects form-shaped requests, and never a
 * WebSocket handshake.
 */
const sameOrigin = createMiddleware<HttpEnv>(async (c, next) => {
  if (c.req.header('origin') !== c.get('services').config.publicOrigin) {
    throw new HTTPException(403, { message: '请求来源不受信任' });
  }
  await next();
});

/**
 * Counts every authentication attempt before any password hashing, so an unauthenticated caller
 * cannot spend the server's CPU on KDF work. The client key comes from the runtime's own view of
 * the socket; forwarded headers are honored only from the trusted internal edge.
 */
const authRateLimit = (scope: 'register' | 'login') =>
  createMiddleware<HttpEnv>(async (c, next) => {
    const { config } = c.get('services');
    const peer = c.env?.server?.requestIP(c.req.raw);
    c.get('limiter').limit(
      scope,
      rateLimitKey(peer?.address, c.req.header('x-forwarded-for'), config.trustForwardedFor),
    );
    await next();
  });

/** The session the presented cookie stands for, or the API's 401. */
async function authenticate(c: Context<HttpEnv>): Promise<AuthenticatedSession> {
  const session = await loadSession(
    c.get('services').database,
    sessionHashFromToken(getCookie(c, SESSION_COOKIE)),
  );
  if (!session) throw new HTTPException(401, { message: '登录状态已失效，请重新登录' });
  return session;
}

const authenticated = createMiddleware<HttpEnv>(async (c, next) => {
  c.set('session', await authenticate(c));
  await next();
});

/**
 * Login credentials are read leniently on purpose: a shape the KDF cannot use must still reach the
 * KDF and come back as the same 401 as a wrong password, never as a validation error.
 */
const loginBody = createMiddleware<
  HttpEnv,
  string,
  { in: { json: LoginInput }; out: { json: { credentials: LoginInput | null } } }
>(async (c, next) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  c.req.addValidatedData('json', { credentials: parsed.success ? parsed.data : null });
  await next();
});

/** `Secure` follows the deployment's public origin, so local HTTP development keeps working. */
function cookieAttributes(c: Context<HttpEnv>): {
  path: string;
  httpOnly: boolean;
  sameSite: 'Strict';
  secure: boolean;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.get('services').config.publicOrigin).protocol === 'https:',
  };
}

function issueSessionCookie(c: Context<HttpEnv>, ticket: SessionTicket, now = Date.now()): void {
  setCookie(c, SESSION_COOKIE, ticket.token, {
    ...cookieAttributes(c),
    maxAge: Math.max(0, Math.floor((ticket.expiresAt - now) / 1000)),
  });
}

function clearSessionCookie(c: Context<HttpEnv>): void {
  deleteCookie(c, SESSION_COOKIE, cookieAttributes(c));
}

/**
 * Domain rejections carry their own status and user-facing message; class identity is not the
 * contract — the documented fields are.
 */
const roomRejectionSchema = z.object({
  status: z.literal([403, 404, 409]),
  userMessage: z.string(),
});

function mapRoomError(
  error: unknown,
  activeReleaseId?: string | null,
): HTTPException | ReleaseError {
  if (error instanceof ReleaseError) return error;
  if (error instanceof HTTPException) return error;
  const rejection = roomRejectionSchema.safeParse(error);
  if (rejection.success) {
    return new HTTPException(rejection.data.status, { message: rejection.data.userMessage });
  }
  console.error(`room failed: ${errorText(error)}`);
  if (activeReleaseId === undefined) return new HTTPException(500, { message: '房间暂时不可用' });
  return new ReleaseError('release:unavailable', activeReleaseId);
}

function mapMatchError(
  error: unknown,
  activeReleaseId: string | null,
): HTTPException | ReleaseError {
  if (error instanceof ReleaseError) return error;
  if (error instanceof HTTPException) return error;
  const rejection = roomRejectionSchema.safeParse(error);
  if (rejection.success) {
    return new HTTPException(rejection.data.status, { message: rejection.data.userMessage });
  }
  console.error(`matchmaking failed: ${errorText(error)}`);
  return new ReleaseError('release:unavailable', activeReleaseId);
}

/** The game runtime this deployment owns; a game route without one is a composition error. */
function requireRuntime(c: Context<HttpEnv>): RoomRuntimePort {
  const rooms = c.get('services').rooms;
  if (!rooms) throw new ReleaseError('release:unavailable', null);
  return rooms;
}

/**
 * The client's compiled release must name this exact server. Missing, empty and wrong values are
 * all the same outcome: this bundle cannot admit that client. WebSocket handshakes present the
 * version through the `release` query parameter, because browsers cannot set custom headers there.
 */
async function requireClientRelease(
  c: Context<HttpEnv>,
  presented: string | undefined,
): Promise<void> {
  const { database, config } = c.get('services');
  if (presented !== config.releaseId) {
    throw new ReleaseError('release:update_required', await activeReleasePointer(database));
  }
}

/**
 * This process serves game traffic only while its own release is `active` or `retiring`:
 * `retiring` keeps reconnects alive for the rooms still finishing, while a `retired` release
 * rejects even if its container is still up, and a merely `staged` one has never served traffic.
 */
async function requireServingRelease(c: Context<HttpEnv>): Promise<void> {
  const { database, config } = c.get('services');
  const [version] = await database
    .select({ state: releaseVersions.state })
    .from(releaseVersions)
    .where(eq(releaseVersions.id, config.releaseId));
  if (!version || version.state === 'staged') {
    throw new ReleaseError('release:unavailable', await activeReleasePointer(database));
  }
  if (version.state === 'retired') {
    throw new ReleaseError('release:update_required', await activeReleasePointer(database));
  }
}

/**
 * The room a client names must belong to this release. A missing room is a 404; a room persisted
 * under another release is retired for this client — it can never be joined from this bundle.
 */
async function requireRoomOnRelease(c: Context<HttpEnv>, roomId: string): Promise<void> {
  const { database, config } = c.get('services');
  const [row] = await database
    .select({ releaseId: rooms.release_id })
    .from(rooms)
    .where(eq(rooms.id, roomId));
  if (!row) throw new HTTPException(404, { message: '房间不存在' });
  if (row.releaseId !== config.releaseId) {
    throw new ReleaseError('release:room_retired', await activeReleasePointer(database));
  }
}

const apiBodyLimit = bodyLimit({
  maxSize: MAX_API_BODY_BYTES,
  onError: (c) => c.json({ error: '请求内容过大' }, 413),
});

const noStore = createMiddleware<HttpEnv>(async (c, next) => {
  await next();
  // Never restamp an upgraded response: the socket belongs to the room runtime now.
  if ((c.req.header('upgrade') ?? '').toLowerCase() === 'websocket') return;
  c.res.headers.set('cache-control', 'no-store');
});

const onMethodNotAllowed = (c: Context<HttpEnv>, methods: string[]) =>
  c.json({ error: '请求方法不被支持' }, 405, { Allow: methods.join(', ') });

function apiOnError(error: unknown, c: Context<HttpEnv>): Response {
  if (error instanceof ReleaseError) {
    if (error.status === 503) c.header('Retry-After', '5');
    return c.json(
      { code: error.code, error: error.message, activeReleaseId: error.activeReleaseId },
      error.status,
    );
  }
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: '请求参数无效' }, 400);
  console.error(`api ${c.req.method} ${c.req.path} failed: ${errorText(error)}`);
  return c.json({ error: '服务器内部错误' }, 500);
}

const zodReject = (
  result: { success: true } | { success: false; error: { issues: { message: string }[] } },
) => {
  if (!result.success) {
    throw new HTTPException(400, {
      message: result.error.issues.map((issue) => issue.message).join('；'),
    });
  }
};

/** Mount-path double check: the game app only ever serves its own release's URL segment. */
const MOUNTED_RELEASE = /^\/api\/releases\/([0-9a-f]{32})(?:\/|$)/;
const mountedReleaseGate = createMiddleware<HttpEnv>(async (c, next) => {
  const mounted = MOUNTED_RELEASE.exec(c.req.path);
  if (mounted && mounted[1] !== c.get('services').config.releaseId) {
    throw new HTTPException(404, { message: '接口不存在' });
  }
  await next();
});

const roomIdGate = createMiddleware<HttpEnv>(async (c, next) => {
  if (!roomIdSchema.safeParse(c.req.param('roomId')).success) {
    throw new HTTPException(404, { message: '房间不存在' });
  }
  await next();
});

/**
 * A unique-constraint violation walking the driver's cause chain: drizzle wraps the PostgreSQL
 * error, and only the original cause carries the SQLSTATE and the constraint name.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === '23505') return true;
    if (current instanceof Error && /duplicate key|unique constraint/i.test(current.message)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Stable identity and lobby surface: session bootstrap, credentials, profile, homepage counters,
 * the admission pointer, and the room locator that outlives releases.
 */
const stableRoutes = new Hono<HttpEnv>({ strict: false })
  .use('/api/*', apiBodyLimit)
  .use('/api/*', noStore)
  .get('/api/release', async (c) => {
    let info: ReleaseInfo;
    try {
      info = await getReleaseInfo(c.get('services').database);
    } catch {
      // No control row is not "open": an unknown admission state stays unavailable.
      throw new ReleaseError('release:unavailable', null);
    }
    return c.json(info);
  })
  .get('/api/session', async (c) => {
    const { database } = c.get('services');
    const session = await loadSession(database, sessionHashFromToken(getCookie(c, SESSION_COOKIE)));
    const body: SessionInfo = {
      user: session?.user ?? null,
    };
    return c.json(body);
  })
  .get('/api/activity', async (c) => {
    let activity: ActivitySummary;
    try {
      activity = await readActivitySummary(c.get('services').database);
    } catch (error) {
      // An unavailable answer stays unavailable: a failed read is never counted as idle.
      console.error(`activity summary failed: ${errorText(error)}`);
      throw new HTTPException(503, { message: '活动数据暂时不可用，请稍后再试。' });
    }
    return c.json(activity);
  })
  .post(
    '/api/register',
    sameOrigin,
    authRateLimit('register'),
    zValidator('json', registerSchema, zodReject),
    async (c) => {
      const { username, password } = c.req.valid('json');
      const { database } = c.get('services');
      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      try {
        await database.insert(accounts).values({
          id,
          username,
          username_key: username.toLowerCase(),
          password_hash: passwordHash,
          created_at: Date.now(),
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HTTPException(409, { message: '该用户名已被使用' });
        }
        throw error;
      }
      // One `now` for the session row and the cookie, so the advertised Max-Age is exact.
      const now = Date.now();
      issueSessionCookie(c, await createSession(database, id, now), now);
      return c.json({ user: { id, username } });
    },
  )
  .post('/api/login', sameOrigin, authRateLimit('login'), loginBody, async (c) => {
    const { credentials } = c.req.valid('json');
    const { database } = c.get('services');
    const [account] = credentials
      ? await database
          .select({
            id: accounts.id,
            username: accounts.username,
            passwordHash: accounts.password_hash,
          })
          .from(accounts)
          .where(eq(accounts.username_key, credentials.username.toLowerCase()))
      : [];
    const stored = account ? account.passwordHash : await unknownAccountHash();
    const verified = await verifyPassword(credentials?.password ?? '', stored);
    if (!account || !credentials || !verified) {
      throw new HTTPException(401, { message: '用户名或密码不正确' });
    }
    const now = Date.now();
    issueSessionCookie(c, await createSession(database, account.id, now), now);
    return c.json({ user: { id: account.id, username: account.username } });
  })
  .post('/api/logout', sameOrigin, async (c) => {
    const services = c.get('services');
    // Revoke even tombstoned sessions. Do not clear the cookie while any release runtime
    // declines to confirm that this session's sockets are closed.
    const tokenHash = sessionHashFromToken(getCookie(c, SESSION_COOKIE));
    if (tokenHash) await revokeSessionEverywhere(services, tokenHash);
    clearSessionCookie(c);
    return c.json({ ok: true as const });
  })
  .get('/api/profile', authenticated, async (c) => {
    const user = c.get('session').user;
    const { database } = c.get('services');
    const [stats] = await database
      .select({
        games: count(),
        wins: sql<number>`coalesce(sum(case when ${results.rank} = 1 then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
        bestCpm: sql<number>`coalesce(max(${results.cpm}), 0)`.mapWith(Number),
      })
      .from(results)
      .where(eq(results.user_id, user.id));
    const history = await database
      .select({
        match_id: results.match_id,
        theme: results.theme,
        damage_dealt: results.damage_dealt,
        hp_remaining: results.hp_remaining,
        spells_cast: results.spells_cast,
        correct_chars: results.correct_chars,
        duration_ms: results.duration_ms,
        rank: results.rank,
        cpm: results.cpm,
        accuracy: results.accuracy,
        created_at: results.created_at,
        input_policy_version: results.input_policy_version,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
        input_recoveries: results.input_recoveries,
        input_min_completion_ratio: results.input_min_completion_ratio,
        input_overloads: results.input_overloads,
        input_recovered_completions: results.input_recovered_completions,
        input_recovery_departures: results.input_recovery_departures,
      })
      .from(results)
      .where(eq(results.user_id, user.id))
      .orderBy(desc(results.created_at), desc(results.match_id))
      .limit(10);
    const body: Profile = {
      user,
      stats: {
        games: Number(stats?.games ?? 0),
        wins: Number(stats?.wins ?? 0),
        bestCpm: Number(stats?.bestCpm ?? 0),
      },
      history,
    };
    return c.json(body);
  })
  .get('/api/rooms/:roomId/location', authenticated, async (c) => {
    const roomId = c.req.param('roomId');
    if (!roomIdSchema.safeParse(roomId).success) {
      throw new HTTPException(404, { message: '房间不存在' });
    }
    const { database } = c.get('services');
    const [row] = await database
      .select({ releaseId: rooms.release_id, state: releaseVersions.state })
      .from(rooms)
      .innerJoin(releaseVersions, eq(releaseVersions.id, rooms.release_id))
      .where(eq(rooms.id, roomId));
    if (!row) throw new HTTPException(404, { message: '房间不存在' });
    const location: RoomLocation = {
      roomId,
      releaseId: row.releaseId,
      state: row.state,
      entryUrl: `/?room=${roomId}`,
    };
    return c.json(location);
  });

export type StableAppType = typeof stableRoutes;

/**
 * Per-release game surface. Main mounts this app at exactly `/api/releases/<config.releaseId>`,
 * so the URL segment is the first release check; the room's persisted release, the release
 * lifecycle state and the client's declared version are checked per route below.
 */
const gameRoutes = new Hono<HttpEnv>({ strict: false })
  .use(mountedReleaseGate)
  .use(apiBodyLimit)
  .use(noStore)
  .use('/rooms/:roomId/*', roomIdGate)
  .post(
    '/rooms',
    sameOrigin,
    authenticated,
    zValidator('json', createRoomSchema, zodReject),
    async (c) => {
      const { theme } = c.req.valid('json');
      const { database, config } = c.get('services');
      const runtime = requireRuntime(c);
      await requireClientRelease(c, c.req.header('X-Spelltype-Release'));
      await requireServingRelease(c);
      if (config.matchAdmission !== 'open') {
        return c.json({ error: '服务器维护中，暂不开始新对局。' }, 503);
      }
      const host = c.get('session').user;
      const roomId = newRoomId();
      try {
        await withAdmission(database, config.releaseId, (tx) =>
          createRoom(tx, {
            id: roomId,
            releaseId: config.releaseId,
            host,
            theme,
            mode: 'private',
          }),
        );
        // The room exists durably now; the runtime adopts its timers and engine state.
        await runtime.refreshRoom(roomId);
      } catch (error) {
        throw mapRoomError(error, await activeReleasePointer(database));
      }
      return c.json({ roomId });
    },
  )
  .get('/rooms/:roomId', authenticated, async (c) => {
    if (c.req.header('X-Spelltype-Protocol') !== WS_PROTOCOL) {
      return c.json(
        { error: '客户端版本已更新，请刷新页面后继续。', protocolVersion: WS_PROTOCOL },
        409,
      );
    }
    const { database } = c.get('services');
    const runtime = requireRuntime(c);
    await requireClientRelease(c, c.req.header('X-Spelltype-Release'));
    await requireServingRelease(c);
    const roomId = c.req.param('roomId');
    await requireRoomOnRelease(c, roomId);
    try {
      return c.json(await runtime.snapshot(roomId, c.get('session').user));
    } catch (error) {
      throw mapRoomError(error, await activeReleasePointer(database));
    }
  })
  .post('/rooms/:roomId/leave', sameOrigin, authenticated, async (c) => {
    const runtime = requireRuntime(c);
    await requireClientRelease(c, c.req.header('X-Spelltype-Release'));
    await requireServingRelease(c);
    const roomId = c.req.param('roomId');
    await requireRoomOnRelease(c, roomId);
    try {
      // The room commits the departure durably before answering, so `left` is never sent on a
      // failure.
      await runtime.leaveRoom(roomId, c.get('session').user.id);
    } catch (error) {
      throw mapRoomError(error);
    }
    return c.json({ left: true as const });
  })
  .get('/rooms/:roomId/ws', sameOrigin, async (c) => {
    const { database } = c.get('services');
    const runtime = requireRuntime(c);
    if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
      throw new HTTPException(426, { message: '需要 WebSocket 升级请求' });
    }
    if (
      !c.req
        .header('Sec-WebSocket-Protocol')
        ?.split(',')
        .some((value) => value.trim() === WS_PROTOCOL)
    ) {
      return c.json(
        { error: '客户端版本已更新，请刷新页面后继续。', protocolVersion: WS_PROTOCOL },
        426,
      );
    }
    const session = await authenticate(c);
    await requireClientRelease(c, c.req.query('release'));
    await requireServingRelease(c);
    const roomId = c.req.param('roomId');
    await requireRoomOnRelease(c, roomId);
    // Read validation before the upgrade: an unauthorized handshake is an HTTP rejection, never a
    // socket that opens and immediately closes.
    await runtime.authorizeSocket(roomId, session);
    const server = c.env?.server;
    if (!server)
      throw new ReleaseError('release:unavailable', await activeReleasePointer(database));
    const upgraded = server.upgrade(c.req.raw, {
      data: { roomId, session, protocolVersion: WS_PROTOCOL },
      headers: { 'Sec-WebSocket-Protocol': WS_PROTOCOL },
    });
    if (!upgraded) throw new HTTPException(426, { message: '需要 WebSocket 升级请求' });
    // Bun takes the socket over on `upgrade`; the response body is discarded.
    return new Response(null);
  })
  .post('/match', sameOrigin, authenticated, async (c) => {
    const { database, config } = c.get('services');
    await requireClientRelease(c, c.req.header('X-Spelltype-Release'));
    await requireServingRelease(c);
    if (config.matchAdmission !== 'open') {
      return c.json({ error: '服务器维护中，暂不开始新对局。' }, 503);
    }
    try {
      return c.json(await acquireMatch(database, config.releaseId, c.get('session').user));
    } catch (error) {
      throw mapMatchError(error, await activeReleasePointer(database));
    }
  })
  .delete('/match', sameOrigin, authenticated, async (c) => {
    const { database, config } = c.get('services');
    const runtime = requireRuntime(c);
    await requireClientRelease(c, c.req.header('X-Spelltype-Release'));
    await requireServingRelease(c);
    try {
      const outcome = await cancelMatch(database, c.get('session').user.id);
      // Refresh only a CONFIRMED cancellation of a room this release owns: `cancelled: false`
      // means a started match still holds the seat (possibly under another release), and a
      // foreign room is the foreign runtime's watcher business — never this process's refresh.
      if (outcome.cancelled && outcome.roomId) {
        const [freed] = await database
          .select({ releaseId: rooms.release_id })
          .from(rooms)
          .where(eq(rooms.id, outcome.roomId));
        if (freed?.releaseId === config.releaseId) await runtime.refreshRoom(outcome.roomId);
      }
      return c.json({ cancelled: outcome.cancelled });
    } catch (error) {
      throw mapMatchError(error, await activeReleasePointer(database));
    }
  })
  .get('/health', async (c) => {
    const { database, config } = c.get('services');
    const runtime = requireRuntime(c);
    // The reported epoch must be THIS process's own ownership, still backed by an unexpired lease
    // on a non-retired version — a stale process could otherwise report its successor's identity.
    const [version] = await database
      .select({
        state: releaseVersions.state,
        runtimeEpoch: releaseVersions.runtime_epoch,
        leaseUntil: releaseVersions.lease_until,
      })
      .from(releaseVersions)
      .where(eq(releaseVersions.id, config.releaseId));
    const valid =
      version !== undefined &&
      version.state !== 'retired' &&
      version.runtimeEpoch === runtime.runtimeEpoch &&
      version.leaseUntil !== null &&
      version.leaseUntil > Date.now();
    if (!valid) {
      return c.json({ error: '运行时身份失效' }, 503, { 'Retry-After': '5' });
    }
    return c.json({
      releaseId: config.releaseId,
      runtimeEpoch: runtime.runtimeEpoch,
      aiConfigured: Boolean(config.ai.apiKey?.trim()),
    });
  });

export type GameAppType = typeof gameRoutes;

/** SHA-256 artifact digest, as produced by the release tooling. */
const artifactDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, '产物摘要无效');
const tokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const operationSchema = z.object({ operationId: z.uuid() });
const stageSchema = operationSchema.extend({
  releaseId: releaseIdSchema,
  artifactDigest: artifactDigestSchema,
});
const checkSchema = operationSchema.extend({ releaseId: releaseIdSchema });
const activateSchema = operationSchema.extend({
  releaseId: releaseIdSchema,
  expectedReleaseId: releaseIdSchema.nullable(),
});
const retireProbeSchema = z.object({ releaseId: releaseIdSchema });
const retireCompleteSchema = z.object({
  releaseId: releaseIdSchema,
  admissionEpoch: z.number().int().min(0),
});
const revokeSchema = z.object({ tokenHash: tokenHashSchema });

/** The admin API's release view: control row plus every known version, in domain field names. */
export interface AdminReleaseState {
  /** The release identity this admin process itself was built from. */
  releaseId: string;
  control: {
    activeReleaseId: string | null;
    revision: number;
    updatedAt: number;
  };
  versions: {
    releaseId: string;
    state: 'staged' | 'active' | 'retiring' | 'retired';
    artifactDigest: string;
    operationId: string;
    admissionEpoch: number;
    runtimeId: string | null;
    runtimeEpoch: number;
    leaseUntil: number | null;
    checkedEpoch: number | null;
    createdAt: number;
    updatedAt: number;
    retiredAt: number | null;
  }[];
}

function versionView(
  row: typeof releaseVersions.$inferSelect,
): AdminReleaseState['versions'][number] {
  return {
    releaseId: row.id,
    state: row.state,
    artifactDigest: row.artifact_digest,
    operationId: row.operation_id,
    admissionEpoch: row.admission_epoch,
    runtimeId: row.runtime_id,
    runtimeEpoch: row.runtime_epoch,
    leaseUntil: row.lease_until,
    checkedEpoch: row.checked_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}

async function releaseStateView(
  database: Database,
  compiledReleaseId: string,
): Promise<AdminReleaseState> {
  const [control] = await database
    .select({
      activeReleaseId: releaseControl.active_release_id,
      revision: releaseControl.revision,
      updatedAt: releaseControl.updated_at,
    })
    .from(releaseControl);
  const versions = await database
    .select()
    .from(releaseVersions)
    .orderBy(releaseVersions.created_at);
  return {
    releaseId: compiledReleaseId,
    control: control ?? { activeReleaseId: null, revision: 0, updatedAt: 0 },
    versions: versions.map(versionView),
  };
}

/**
 * Production probe: the deterministic per-release game container health endpoint. No URL is ever
 * accepted from HTTP input or environment; tests and the local harness inject `releaseProbe`.
 */
function defaultReleaseProbe(services: ServerServices): ReleaseProbe {
  return async (releaseId) => {
    const { config, rooms } = services;
    if (rooms && releaseId === config.releaseId) {
      return { releaseId, runtimeEpoch: rooms.runtimeEpoch };
    }
    // The game container serves its health route under its own release prefix.
    const response = await fetch(`http://game-${releaseId}:3000${gameApiBase(releaseId)}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new ReleaseConflict(`运行时健康检查失败 (${response.status})`);
    }
    const body = (await response.json()) as Partial<RuntimeHealth>;
    if (body.releaseId !== releaseId || typeof body.runtimeEpoch !== 'number') {
      throw new ReleaseConflict('运行时健康检查响应无效');
    }
    return { releaseId, runtimeEpoch: body.runtimeEpoch };
  };
}

function adminOnError(error: unknown, c: Context<HttpEnv>): Response {
  if (error instanceof ReleaseConflict) return c.json({ error: error.message }, error.status);
  return apiOnError(error, c);
}

/**
 * The bearer gate: only the configured release admin token, compared in constant time; a missing
 * or malformed configuration fails closed with 503, and a same-origin browser context is required
 * when an Origin header is present at all.
 */
const bearerGate = createMiddleware<HttpEnv>(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const { config } = c.get('services');
  if (!config.adminToken) return c.json({ error: '发布管理未配置' }, 503);
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin && origin !== config.publicOrigin) {
    return c.json({ error: '请求来源不正确' }, 403);
  }
  const token = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header('Authorization') ?? '')?.[1];
  if (!token || !secretsEqual(config.adminToken, token)) {
    return c.json({ error: '发布凭据无效' }, 401);
  }
  await next();
});

/** Loopback release-operations surface: staging, health checks, activation, retirement, revocation. */
const adminRoutes = new Hono<HttpEnv>({ strict: false })
  .get('/health', (c) => c.json({ ok: true as const }))
  .use(bearerGate)
  .get('/release', async (c) => {
    const { database, config } = c.get('services');
    return c.json(await releaseStateView(database, config.releaseId));
  })
  .post('/release/stage', zValidator('json', stageSchema), async (c) => {
    const { operationId, releaseId, artifactDigest } = c.req.valid('json');
    const { database, config } = c.get('services');
    await stageRelease(database, { operationId, releaseId, artifactDigest });
    return c.json(await releaseStateView(database, config.releaseId));
  })
  .post('/release/check', zValidator('json', checkSchema), async (c) => {
    const { operationId, releaseId } = c.req.valid('json');
    const { database } = c.get('services');
    const probe = c.get('releaseProbe') ?? defaultReleaseProbe(c.get('services'));
    const version = await checkRelease(database, { operationId, releaseId }, probe);
    return c.json(versionView(version));
  })
  .post('/release/activate', zValidator('json', activateSchema), async (c) => {
    const { operationId, releaseId, expectedReleaseId } = c.req.valid('json');
    const { database } = c.get('services');
    return c.json(
      await activateRelease(database, {
        operationId,
        releaseId,
        expectedReleaseId: expectedReleaseId ?? null,
      }),
    );
  })
  .post('/release/retire/probe', zValidator('json', retireProbeSchema), async (c) => {
    const { releaseId } = c.req.valid('json');
    const { database } = c.get('services');
    return c.json(await probeRetirement(database, releaseId));
  })
  .post('/release/retire/complete', zValidator('json', retireCompleteSchema), async (c) => {
    const { releaseId, admissionEpoch } = c.req.valid('json');
    const { database, config } = c.get('services');
    await completeRetirement(database, { releaseId, admissionEpoch });
    return c.json(await releaseStateView(database, config.releaseId));
  })
  .post('/sessions/revoke', zValidator('json', revokeSchema), async (c) => {
    const { tokenHash } = c.req.valid('json');
    const runtime = requireRuntime(c);
    await runtime.revokeSession(tokenHash);
    return c.json({ ok: true as const });
  });

export type AdminAppType = typeof adminRoutes;

/** Per-instance services travel through context variables; the route trees above carry the types. */
function composeApp(
  services: ServerServices,
  options: { releaseProbe?: ReleaseProbe } = {},
): ServerApp {
  const app = new Hono<HttpEnv>({ strict: false });
  // One limiter per app instance: the windows must accumulate across requests.
  const limiter = createAuthRateLimiter(authRateLimits(services.config));
  app.use('*', (c, next) => {
    c.set('services', services);
    c.set('limiter', limiter);
    if (options.releaseProbe) c.set('releaseProbe', options.releaseProbe);
    return next();
  });
  return app;
}

export function createStableApp(services: ServerServices): ServerApp {
  const app = composeApp(services);
  app.use('*', methodNotAllowed({ app, onMethodNotAllowed }));
  app.onError(apiOnError);
  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: '接口不存在' }, 404)
      : c.text('Not Found', 404),
  );
  app.route('/', stableRoutes);
  return app;
}

export function createGameApp(services: ServerServices): ServerApp {
  const app = composeApp(services);
  app.use('*', methodNotAllowed({ app, onMethodNotAllowed }));
  app.onError(apiOnError);
  app.notFound((c) => c.json({ error: '接口不存在' }, 404));
  app.route('/', gameRoutes);
  return app;
}

export function createAdminApp(services: ServerServices, releaseProbe?: ReleaseProbe): ServerApp {
  const app = composeApp(services, { releaseProbe });
  app.use('*', methodNotAllowed({ app, onMethodNotAllowed }));
  app.onError(adminOnError);
  app.notFound((c) => c.json({ error: '接口不存在' }, 404));
  app.route('/', adminRoutes);
  return app;
}
