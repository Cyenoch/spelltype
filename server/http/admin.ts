import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { MAX_BAN_DURATION_MS } from '../../shared/admin';
import { MAX_THEME_CHARS } from '../../shared/protocol';
import { getAdminBookDetail, listAdminBooks } from '../admin/books';
import { getAdminMatchDetail, listAdminMatches } from '../admin/matches';
import { getAdminOverview } from '../admin/overview';
import { banUser, getAdminUserDetail, listAdminUsers } from '../admin/users';
import { enterMaintenance, inspectMaintenance, leaveMaintenance } from '../maintenance/control';
import { authenticated, requireRuntime, sameOrigin, zodReject, type HttpEnv } from './context';

const administrator = createMiddleware<HttpEnv>(async (c, next) => {
  if (c.get('session').role !== 'admin') {
    throw new HTTPException(403, { message: '需要管理员权限。' });
  }
  await next();
});

const maintenanceChangeSchema = z
  .object({
    mode: z.enum(['open', 'draining']),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** 管理端列表输入：页码 1 起且有界，搜索词按字面子串处理；非法值以 400 明确拒绝。 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  q: z.string().trim().max(100).default(''),
});

/** 对局列表在通用搜索之外允许阶段、主题与参与者过滤；空阶段表示不过滤。 */
const matchListQuerySchema = listQuerySchema.extend({
  phase: z
    .enum(['lobby', 'generating', 'countdown', 'playing', 'finished'])
    .or(z.literal(''))
    .default(''),
  userId: z.string().trim().min(1).max(64).optional(),
  theme: z.string().trim().min(1).max(MAX_THEME_CHARS).optional(),
});

const detailPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

// 详情标识为任意文本：仅以长度约束形态，存在与否交由数据库裁决（404）。
const userParamsSchema = z.object({ userId: z.string().trim().min(1).max(64) });
const matchParamsSchema = z.object({ matchId: z.string().trim().min(1).max(64) });
const bookParamsSchema = z.object({ theme: z.string().trim().min(1).max(MAX_THEME_CHARS) });

/** 封禁时长：正整数毫秒且有界；`null` 表示永久封禁。 */
const banRequestSchema = z
  .object({
    durationMs: z.number().int().positive().max(MAX_BAN_DURATION_MS).nullable(),
  })
  .strict();

/** 每次通过身份验证的请求都会从数据库重新读取账户角色。 */
export const adminRoutes = new Hono<HttpEnv>({ strict: false })
  .use('*', authenticated, administrator)
  .get('/maintenance', async (c) => c.json(await inspectMaintenance(c.get('services').database)))
  .post(
    '/maintenance',
    sameOrigin,
    zValidator('json', maintenanceChangeSchema, zodReject),
    async (c) => {
      const { mode, expectedRevision } = c.req.valid('json');
      const { database } = c.get('services');
      const info =
        mode === 'draining'
          ? await enterMaintenance(database, expectedRevision)
          : await leaveMaintenance(database, expectedRevision, requireRuntime(c).runtimeEpoch);
      return c.json(info);
    },
  )
  .get('/overview', async (c) => c.json(await getAdminOverview(c.get('services').database)))
  .get('/users', zValidator('query', listQuerySchema, zodReject), async (c) => {
    const { page, q } = c.req.valid('query');
    return c.json(await listAdminUsers(c.get('services').database, { page, q }));
  })
  .get(
    '/users/:userId',
    zValidator('param', userParamsSchema, zodReject),
    zValidator('query', detailPageSchema, zodReject),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { page } = c.req.valid('query');
      const detail = await getAdminUserDetail(c.get('services').database, userId, page);
      if (detail === null) throw new HTTPException(404, { message: '用户不存在。' });
      return c.json(detail);
    },
  )
  .post(
    '/users/:userId/ban',
    sameOrigin,
    zValidator('param', userParamsSchema, zodReject),
    zValidator('json', banRequestSchema, zodReject),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { durationMs } = c.req.valid('json');
      const { database } = c.get('services');
      const outcome = await banUser(database, userId, durationMs);
      if (outcome.kind === 'missing') throw new HTTPException(404, { message: '用户不存在。' });
      // 管理员（含操作者自身）绝不被封禁：防止运维把自己锁在控制台之外。
      if (outcome.kind === 'admin')
        throw new HTTPException(409, { message: '无法封禁管理员账号。' });
      // 封禁已提交；在线连接的终止必须由运行时如实确认 —— 与登出相同的确认语义。
      // 运行时缺席或任一房间无法确认物理关闭：保留封禁并让操作者重试断开。
      const rooms = c.get('services').rooms;
      if (rooms === null)
        throw new HTTPException(503, { message: '封禁已生效，但断开在线连接失败，请重试。' });
      try {
        await rooms.revokeUser(outcome.userId);
        await database.transaction((tx) => rooms.assertOwnership(tx));
      } catch {
        throw new HTTPException(503, { message: '封禁已生效，但断开在线连接失败，请重试。' });
      }
      return c.json({ ban: outcome.ban });
    },
  )
  .get('/matches', zValidator('query', matchListQuerySchema, zodReject), async (c) => {
    const { page, q, phase, userId, theme } = c.req.valid('query');
    return c.json(
      await listAdminMatches(c.get('services').database, {
        page,
        q,
        phase: phase === '' ? null : phase,
        theme: theme ?? null,
        userId: userId ?? null,
      }),
    );
  })
  .get('/matches/:matchId', zValidator('param', matchParamsSchema, zodReject), async (c) => {
    const detail = await getAdminMatchDetail(
      c.get('services').database,
      c.req.valid('param').matchId,
    );
    if (detail === null) throw new HTTPException(404, { message: '对局不存在或从未开始。' });
    return c.json(detail);
  })
  .get('/books', zValidator('query', listQuerySchema, zodReject), async (c) => {
    const { page, q } = c.req.valid('query');
    return c.json(await listAdminBooks(c.get('services').database, { page, q }));
  })
  .get(
    '/books/:theme',
    zValidator('param', bookParamsSchema, zodReject),
    zValidator('query', detailPageSchema, zodReject),
    async (c) => {
      const { theme } = c.req.valid('param');
      const { page } = c.req.valid('query');
      const detail = await getAdminBookDetail(c.get('services').database, theme, page);
      if (detail === null) throw new HTTPException(404, { message: '法术书不存在或尚未生成。' });
      return c.json(detail);
    },
  );
