import { GameRoom } from './room.ts';
import { Matchmaker, userShardName } from './matchmaker.ts';
import type { Env } from './env';
import { PASSWORD_MAX_CHARS } from '../shared/protocol';
import type { MatchResult, Profile, RoomInit, SessionInfo } from '../shared/protocol';
import {
  clearedSessionCookieHeader,
  createSession,
  hashPassword,
  loadSession,
  normalizeUsername,
  readPassword,
  requireSession,
  revokeSession,
  sessionCookieHeader,
  sessionHashFromRequest,
  unknownAccountHash,
  verifyPassword,
  type ActiveSession
} from './auth.ts';
import {
  HttpError,
  assertSameOrigin,
  enforceAuthRateLimit,
  errorResponse,
  errorText,
  isSecureRequest,
  json,
  readJsonBody
} from './http.ts';
import { ROOM_ID_PATTERN, newRoomId, readDifficulty, readTheme } from './ids.ts';

export { GameRoom, Matchmaker };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await routeApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message);
      console.error(`api ${request.method} ${url.pathname} failed: ${errorText(err)}`);
      return errorResponse(500, '服务器内部错误');
    }
  }
} satisfies ExportedHandler<Env>;

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const method = request.method.toUpperCase();
  const resource = segments[1];

  if (resource === 'session' && segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed();
    return handleSession(request, env);
  }
  if (resource === 'register' && segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed();
    return handleRegister(request, env, url);
  }
  if (resource === 'login' && segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed();
    return handleLogin(request, env, url);
  }
  if (resource === 'logout' && segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed();
    return handleLogout(request, env, url);
  }
  if (resource === 'profile' && segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed();
    return handleProfile(request, env);
  }
  if (resource === 'match' && segments.length === 2) {
    if (method === 'POST') return handleMatchStart(request, env, url);
    if (method === 'DELETE') return handleMatchCancel(request, env, url);
    return methodNotAllowed();
  }
  if (resource === 'rooms') {
    if (segments.length === 2) {
      if (method !== 'POST') return methodNotAllowed();
      return handleCreateRoom(request, env, url);
    }
    const roomId = segments[2];
    if (!ROOM_ID_PATTERN.test(roomId)) return errorResponse(404, '房间不存在');
    if (segments.length === 3) {
      if (method !== 'GET') return methodNotAllowed();
      return handleRoomSnapshot(request, env, roomId);
    }
    if (segments.length === 4 && segments[3] === 'ws') {
      if (method !== 'GET') return methodNotAllowed();
      return handleRoomSocket(request, env, url, roomId);
    }
  }
  return errorResponse(404, '接口不存在');
}

function methodNotAllowed(): Response {
  return errorResponse(405, '请求方法不被支持');
}

function aiIsConfigured(env: Env): boolean {
  return typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim() !== '';
}

// ------------------------------------------------------------------ accounts

async function handleSession(request: Request, env: Env): Promise<Response> {
  const session = await loadSession(env, request);
  const body: SessionInfo = { user: session?.user ?? null, aiConfigured: aiIsConfigured(env) };
  return json(body);
}

async function handleRegister(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  await enforceAuthRateLimit(env, request, 'register');
  const body = await readJsonBody(request);
  const username = normalizeUsername(body.username);
  const password = readPassword(body.password);
  if (!username) throw new HttpError(400, '用户名需为 2—20 个中文、字母、数字或下划线');
  if (!password) throw new HttpError(400, '密码长度需为 10—128 个字符');

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const passwordHash = await hashPassword(password);
  try {
    await env.DB.prepare(
      'INSERT INTO accounts (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, username.username, username.key, passwordHash, createdAt)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, '该用户名已被使用');
    throw err;
  }
  const user = { id, username: username.username };
  const ticket = await createSession(env, id);
  return json({ user }, 200, { 'Set-Cookie': sessionCookieHeader(ticket, isSecureRequest(url)) });
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  await enforceAuthRateLimit(env, request, 'login');
  const body = await readJsonBody(request);
  const username = normalizeUsername(body.username);
  const supplied = typeof body.password === 'string' ? body.password : null;
  const candidate = supplied !== null && [...supplied].length <= PASSWORD_MAX_CHARS ? supplied : null;
  const account = username
    ? await env.DB.prepare('SELECT id, username, password_hash FROM accounts WHERE username_key = ?')
        .bind(username.key)
        .first<{ id: string; username: string; password_hash: string }>()
    : null;
  // Unknown usernames verify against a dummy record so the response time does not reveal existence,
  // and the KDF always runs so an over-long or missing password is not answered faster.
  const stored = account ? account.password_hash : await unknownAccountHash();
  const verified = await verifyPassword(candidate ?? '', stored);
  if (!account || candidate === null || !verified) throw new HttpError(401, '用户名或密码不正确');
  const user = { id: account.id, username: account.username };
  const ticket = await createSession(env, account.id);
  return json({ user }, 200, { 'Set-Cookie': sessionCookieHeader(ticket, isSecureRequest(url)) });
}

async function handleLogout(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  // Revocation follows the bearer the request presents, never a live session lookup: a logout must also
  // drive a session that is already tombstoned (or lapsed while a room still holds its socket), because
  // the token's owner is the one asking. A refusal from any room throws 503 and the cookie is NOT
  // cleared, so a "successful" logout can never hide a socket that is still connected.
  const tokenHash = sessionHashFromRequest(request);
  if (tokenHash) await revokeSession(env, tokenHash);
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookieHeader(isSecureRequest(url)) });
}

/**
 * One stored `results` row, mapped straight through: the table holds survival results only, so every
 * column here is a real measurement of the match and `accuracy` is the only unknown-when-absent value.
 */
type ResultRow = {
  match_id: string;
  theme: string;
  damage_dealt: number;
  hp_remaining: number;
  spells_cast: number;
  correct_chars: number;
  duration_ms: number;
  rank: number;
  cpm: number;
  accuracy: number | null;
  created_at: number;
};

async function handleProfile(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(env, request);
  const stats = await env.DB.prepare(
    'SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END), 0) AS wins, COALESCE(MAX(cpm), 0) AS bestCpm FROM results WHERE user_id = ?'
  )
    .bind(session.user.id)
    .first<{ games: number; wins: number; bestCpm: number }>();
  const history = await env.DB.prepare(
    'SELECT match_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms, rank, cpm, accuracy, created_at FROM results WHERE user_id = ? ORDER BY created_at DESC, match_id DESC LIMIT 10'
  )
    .bind(session.user.id)
    .all<ResultRow>();
  const body: Profile = {
    user: session.user,
    stats: { games: stats?.games ?? 0, wins: stats?.wins ?? 0, bestCpm: stats?.bestCpm ?? 0 },
    history: (history.results ?? []).map(readMatchResult)
  };
  return json(body);
}

function readMatchResult(row: ResultRow): MatchResult {
  return {
    match_id: row.match_id,
    theme: row.theme,
    damage_dealt: row.damage_dealt,
    hp_remaining: row.hp_remaining,
    spells_cast: row.spells_cast,
    correct_chars: row.correct_chars,
    duration_ms: row.duration_ms,
    rank: row.rank,
    cpm: row.cpm,
    accuracy: row.accuracy,
    created_at: row.created_at
  };
}

function isUniqueViolation(err: unknown): boolean {
  const message = errorText(err);
  return message.includes('UNIQUE') || message.includes('constraint failed');
}

// ------------------------------------------------------------------ rooms

async function handleCreateRoom(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  const session = await requireSession(env, request);
  const body = await readJsonBody(request);
  const theme = readTheme(body.theme);
  const difficulty = readDifficulty(body.difficulty);
  if (!theme) throw new HttpError(400, '主题需为 1—80 个字符');
  if (!difficulty) throw new HttpError(400, '难度参数不正确');

  const roomId = newRoomId();
  const init: RoomInit = { id: roomId, host: session.user, theme, difficulty, mode: 'private' };
  try {
    await env.ROOMS.get(env.ROOMS.idFromName(roomId)).initialize(init);
  } catch (err) {
    throw mapRoomError(err);
  }
  return json({ roomId });
}

async function handleRoomSnapshot(request: Request, env: Env, roomId: string): Promise<Response> {
  const session = await requireSession(env, request);
  try {
    const snapshot = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).snapshot(session.user);
    return json(snapshot);
  } catch (err) {
    throw mapRoomError(err);
  }
}

async function handleRoomSocket(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  // WebSocket handshakes carry cookies and are not subject to CORS, so origin comes first.
  assertSameOrigin(request, url);
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, '需要 WebSocket 升级请求');
  }
  const session = await requireSession(env, request);
  const headers = trustedRoomHeaders(session, roomId);
  request.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith('sec-websocket-')) headers.set(name, value);
  });
  const target = new URL(url.pathname, url.origin);
  try {
    return await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request(target, { method: 'GET', headers }));
  } catch (err) {
    throw mapRoomError(err);
  }
}

/**
 * Rebuilt from scratch: the browser's own headers never reach the room, so `x-user-id` and friends
 * cannot be spoofed by a client.
 */
function trustedRoomHeaders(session: ActiveSession, roomId: string): Headers {
  const headers = new Headers();
  headers.set('upgrade', 'websocket');
  headers.set('connection', 'Upgrade');
  headers.set('x-user-id', session.user.id);
  headers.set('x-username', encodeURIComponent(session.user.username));
  headers.set('x-session-hash', session.tokenHash);
  headers.set('x-session-expires', String(session.expiresAt));
  headers.set('x-room-id', roomId);
  return headers;
}

function mapRoomError(err: unknown): HttpError {
  const message = errorText(err);
  const userMessage = (err as { userMessage?: unknown }).userMessage;
  const detail = typeof userMessage === 'string' && userMessage.length > 0 ? userMessage : null;
  if (message.includes('room:not_found')) return new HttpError(404, detail ?? '房间不存在或已结束');
  if (message.includes('room:full')) return new HttpError(409, detail ?? '房间已满');
  if (message.includes('room:in_progress')) return new HttpError(409, detail ?? '比赛已经开始，无法加入');
  if (message.includes('room:reservation_gone')) return new HttpError(409, detail ?? '匹配席位已失效，请重新匹配');
  console.error(`room rpc failed: ${message}`);
  return new HttpError(500, '房间暂时不可用');
}

// ------------------------------------------------------------------ matchmaking

async function handleMatchStart(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  const session = await requireSession(env, request);
  const body = await readJsonBody(request);
  const difficulty = readDifficulty(body.difficulty);
  if (!difficulty) throw new HttpError(400, '难度参数不正确');
  const shard = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(userShardName(session.user.id)));
  try {
    return json(await shard.acquire(session.user, difficulty));
  } catch (err) {
    throw mapMatchError(err);
  }
}

async function handleMatchCancel(request: Request, env: Env, url: URL): Promise<Response> {
  assertSameOrigin(request, url);
  const session = await requireSession(env, request);
  const shard = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(userShardName(session.user.id)));
  try {
    return json(await shard.cancel(session.user.id));
  } catch (err) {
    throw mapMatchError(err);
  }
}

function mapMatchError(err: unknown): HttpError {
  const message = errorText(err);
  if (message.includes('match:conflict')) {
    return new HttpError(409, '你正在其他难度排队，请先取消当前匹配');
  }
  if (message.includes('match:cancelled')) {
    return new HttpError(409, '匹配已取消，请重新发起匹配');
  }
  console.error(`matchmaker failed: ${message}`);
  return new HttpError(503, '匹配服务暂时不可用，请稍后再试');
}
