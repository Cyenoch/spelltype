import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import type { Database } from '../db';
import { accounts, wechatLoginAttempts, wechatRelayTokens } from '../db/schema';
import { createSession, hashToken } from './sessions';

export const WECHAT_STATE_COOKIE = 'spelltype_wechat_state';
export const WECHAT_STATE_TTL_SECONDS = 300;
export const WECHAT_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/auth/wechat/callback';
const BOOTSTRAP_ADMIN_UNION_ID = 'omBLS6xCiew0470A53hBYx0mzCbw';
const relaySchema = z.object({
  v: z.literal(1),
  iss: z.string(),
  aud: z.string(),
  app_id: z.string().min(1),
  provider: z.literal('wechat'),
  channel: z.enum(['open', 'mp']),
  iat: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000),
  exp: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000),
  jti: z.string().min(1).max(256),
  openid: z.string().min(1).max(256),
  unionid: z.string().min(1).max(256).optional(),
  nickname: z.string().max(1024).optional(),
});

function invalidLogin(): HTTPException {
  return new HTTPException(401, { message: '微信登录已失效，请重新发起登录。' });
}

function requireBridge(config: ServerConfig) {
  if (!config.wechatBridge) {
    throw new HTTPException(503, { message: '微信登录尚未配置。' });
  }
  return config.wechatBridge;
}

/** 微信凭据由桥接服务保管；本服务仅接收其签名的身份信息。 */
function verifyRelay(token: string, config: ServerConfig, now: number) {
  const bridge = requireBridge(config);
  if (token.length > 8192) throw invalidLogin();
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw invalidLogin();
  const expected = createHmac('sha256', bridge.appKey).update(match[1]).digest('base64url');
  if (!timingSafeEqual(Buffer.from(match[2]), Buffer.from(expected))) throw invalidLogin();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw invalidLogin();
  }
  const parsed = relaySchema.safeParse(json);
  if (!parsed.success) throw invalidLogin();
  const payload = parsed.data;
  if (
    payload.iss !== bridge.baseUrl ||
    payload.aud !== config.publicOrigin ||
    payload.app_id !== bridge.appId ||
    payload.exp * 1000 <= now ||
    payload.iat * 1000 > now ||
    payload.exp <= payload.iat
  )
    throw invalidLogin();
  return payload;
}

export async function beginWechatLogin(
  database: Database,
  config: ServerConfig,
  roomId: string | null,
) {
  const bridge = requireBridge(config);
  const now = Date.now();
  const state = randomBytes(32).toString('base64url');
  await database.transaction(async (tx) => {
    await tx.delete(wechatLoginAttempts).where(lte(wechatLoginAttempts.expires_at, now));
    await tx.delete(wechatRelayTokens).where(lte(wechatRelayTokens.expires_at, now));
    await tx.insert(wechatLoginAttempts).values({
      state_hash: hashToken(state),
      room_id: roomId,
      expires_at: now + WECHAT_STATE_TTL_SECONDS * 1000,
    });
  });
  const callback = new URL(CALLBACK_PATH, config.publicOrigin);
  const url = new URL(`${bridge.baseUrl}/api/auth/wechat/bridge/start`);
  url.searchParams.set('app_id', bridge.appId);
  url.searchParams.set('state', state);
  url.searchParams.set('return_url', callback.href);
  url.searchParams.set('channel', 'auto');
  url.searchParams.set('mp_scope', 'snsapi_userinfo');
  return { state, url: url.href };
}

/** 即使发生错误也须作废浏览器端的状态标识，防止失败的回调被冒用其他身份重试。 */
export async function consumeWechatAttempt(database: Database, state: string) {
  const [attempt] = await database
    .delete(wechatLoginAttempts)
    .where(
      and(
        eq(wechatLoginAttempts.state_hash, hashToken(state)),
        gt(wechatLoginAttempts.expires_at, Date.now()),
      ),
    )
    .returning();
  if (!attempt) throw invalidLogin();
  return attempt;
}

/** 中继令牌的 jti 在所有进程和并发回调中最多只能签发一次会话。 */
export async function finishWechatLogin(database: Database, config: ServerConfig, token: string) {
  const now = Date.now();
  const payload = verifyRelay(token, config, now);
  const identity = payload.unionid
    ? `union:${payload.unionid}`
    : `${payload.channel}:${payload.openid}`;
  const nickname = payload.nickname?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const username = nickname ? Array.from(nickname).slice(0, 64).join('') : '微信玩家';
  return database.transaction(async (tx) => {
    const claimed = await tx
      .insert(wechatRelayTokens)
      .values({
        jti: payload.jti,
        expires_at: payload.exp * 1000,
      })
      .onConflictDoNothing()
      .returning();
    if (claimed.length === 0) throw invalidLogin();
    const [account] = await tx
      .insert(accounts)
      .values({
        id: crypto.randomUUID(),
        username,
        wechat_identity: identity,
        role: payload.unionid === BOOTSTRAP_ADMIN_UNION_ID ? 'admin' : 'user',
        created_at: now,
      })
      .onConflictDoUpdate({
        target: accounts.wechat_identity,
        set: { username: nickname ? username : accounts.username },
      })
      .returning();
    return createSession(tx, account.id, now);
  });
}
