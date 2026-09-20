import type { Server } from 'bun';
import { type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { MAX_API_BODY_BYTES, WS_PROTOCOL, type AccountBan } from '../../shared/protocol';
import { MaintenanceError } from '../../shared/maintenance';
import { SESSION_COOKIE, loadSession, sessionHashFromToken } from '../auth/sessions';
import type {
  AuthenticatedSession,
  RoomRuntimePort,
  RoomSocketData,
  ServerServices,
} from '../contracts';
import { MaintenanceConflict } from '../maintenance/control';
import { roomIdSchema } from '../../shared/validation';
import { rateLimitKey, type AuthRateLimiter } from './rate-limit';

export type HttpEnv = {
  Bindings: { server?: Server<RoomSocketData> };
  Variables: { services: ServerServices; session: AuthenticatedSession; limiter: AuthRateLimiter };
};

export const sameOrigin = createMiddleware<HttpEnv>(async (c, next) => {
  if (c.req.header('origin') !== c.get('services').config.publicOrigin) {
    throw new HTTPException(403, { message: '请求来源不受信任' });
  }
  await next();
});

export const authRateLimit = (scope: 'wechat-start' | 'wechat-callback') =>
  createMiddleware<HttpEnv>(async (c, next) => {
    const { config } = c.get('services');
    const peer = c.env?.server?.requestIP(c.req.raw);
    c.get('limiter').limit(
      scope,
      rateLimitKey(
        peer?.address,
        config.trustForwardedFor ? c.req.header(config.trustForwardedFor) : undefined,
        config.trustForwardedFor,
      ),
    );
    await next();
  });

export async function authenticate(c: Context<HttpEnv>): Promise<AuthenticatedSession> {
  const session = await loadSession(
    c.get('services').database,
    sessionHashFromToken(getCookie(c, SESSION_COOKIE)),
  );
  if (!session) throw new HTTPException(401, { message: '登录状态已失效，请重新登录' });
  return session;
}

export const authenticated = createMiddleware<HttpEnv>(async (c, next) => {
  c.set('session', await authenticate(c));
  await next();
});

/**
 * 封禁账户的统一拒绝提示：永久与定时封禁分别说明；
 * 到期时间以 ISO-8601 UTC 呈现，与 `SessionInfo.ban` 携带的数据一致。
 */
export function banRejectionMessage(ban: AccountBan): string {
  return ban.expiresAt === null
    ? '该账号已被永久封禁。'
    : `该账号已被封禁，将于 ${new Date(ban.expiresAt).toISOString()} 解封。`;
}

/**
 * 受保护接口的封禁闸门：封禁中的账户仅保留会话读取与登出。
 * 判定依据是本请求刚从数据库读取的会话 —— 封禁提交后的下一次请求立即生效。
 */
export const notBanned = createMiddleware<HttpEnv>(async (c, next) => {
  const { ban } = c.get('session');
  if (ban !== null) throw new HTTPException(403, { message: banRejectionMessage(ban) });
  await next();
});

export function requireRuntime(c: Context<HttpEnv>): RoomRuntimePort {
  const runtime = c.get('services').rooms;
  if (!runtime) throw new MaintenanceError('maintenance:unavailable');
  return runtime;
}

/** 就绪检查用于证明该进程仍持有写入者租约（writer lease），而不仅是能响应 HTTP 请求。 */
export async function assertRuntimeHealthy(c: Context<HttpEnv>): Promise<void> {
  const runtime = requireRuntime(c);
  try {
    await c.get('services').database.transaction((tx) => runtime.assertOwnership(tx));
  } catch {
    throw new MaintenanceError('maintenance:unavailable');
  }
}

export const protocolGate = createMiddleware<HttpEnv>(async (c, next) => {
  if (c.req.header('X-Spelltype-Protocol') !== WS_PROTOCOL) {
    return c.json(
      {
        code: 'protocol:mismatch' as const,
        error: '客户端版本已更新，请刷新页面后继续。',
        protocolVersion: WS_PROTOCOL,
      },
      409,
    );
  }
  await next();
});

export const roomIdGate = createMiddleware<HttpEnv>(async (c, next) => {
  if (!roomIdSchema.safeParse(c.req.param('roomId')).success) {
    throw new HTTPException(404, { message: '房间不存在' });
  }
  await next();
});

export const apiBodyLimit = bodyLimit({
  maxSize: MAX_API_BODY_BYTES,
  onError: (c) => c.json({ error: '请求内容过大' }, 413),
});

export const noStore = createMiddleware<HttpEnv>(async (c, next) => {
  await next();
  if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket')
    c.res.headers.set('cache-control', 'no-store');
});

const roomRejectionSchema = z.object({
  status: z.literal([403, 404, 409]),
  userMessage: z.string(),
});

export function mapGameError(error: unknown): HTTPException | MaintenanceError {
  if (error instanceof MaintenanceError || error instanceof HTTPException) return error;
  const rejection = roomRejectionSchema.safeParse(error);
  if (rejection.success)
    return new HTTPException(rejection.data.status, { message: rejection.data.userMessage });
  console.error('[game] operation failed', error instanceof Error ? error.name : typeof error);
  return new HTTPException(503, { message: '对局服务暂不可用，请稍后重试。' });
}

export function apiOnError(error: unknown, c: Context<HttpEnv>): Response {
  c.header('Cache-Control', 'no-store');
  if (error instanceof MaintenanceError) {
    c.header('Retry-After', '5');
    return c.json({ code: error.code, error: error.message }, error.status);
  }
  if (error instanceof MaintenanceConflict) return c.json({ error: error.message }, 409);
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: '请求参数无效' }, 400);
  console.error(
    '[api] request failed',
    c.req.method,
    c.req.path,
    error instanceof Error ? error.name : typeof error,
  );
  return c.json({ error: '服务器内部错误' }, 500);
}

export const zodReject = (
  result: { success: true } | { success: false; error: { issues: { message: string }[] } },
) => {
  if (!result.success)
    throw new HTTPException(400, {
      message: result.error.issues.map((issue) => issue.message).join('；'),
    });
};
