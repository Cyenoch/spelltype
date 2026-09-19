import { timingSafeEqual } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  enterMaintenance,
  inspectMaintenance,
  leaveMaintenance,
  MaintenanceConflict,
} from '../maintenance/control';
import { requireRuntime, zodReject, type HttpEnv } from './context';

// 该凭据特意仅限制在此路由组内生效，绝不扩展到管理员会话。
const maintenanceCredential = createMiddleware<HttpEnv>(async (c, next) => {
  const expected = c.get('services').config.maintenanceToken;
  if (!expected) throw new HTTPException(503, { message: '自动化维护接口未配置。' });
  const supplied = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header('Authorization') ?? '')?.[1];
  if (!supplied || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new HTTPException(401, { message: '自动化维护凭据无效。' });
  }
  await next();
});

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const transitionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('draining'), expectedRevision: revisionSchema }).strict(),
  z
    .object({
      mode: z.literal('open'),
      expectedRevision: revisionSchema,
      expectedRuntimeEpoch: revisionSchema,
    })
    .strict(),
]);

/** CI 可以变更准入状态并观察排空屏障（drain barriers）；但绝不会被授予容器控制权限。 */
export const automationRoutes = new Hono<HttpEnv>({ strict: false })
  .use('*', maintenanceCredential)
  .get('/maintenance', async (c) => c.json(await inspectMaintenance(c.get('services').database)))
  .post('/maintenance', zValidator('json', transitionSchema, zodReject), async (c) => {
    const input = c.req.valid('json');
    const { database } = c.get('services');
    if (input.mode === 'draining')
      return c.json(await enterMaintenance(database, input.expectedRevision));
    if (requireRuntime(c).runtimeEpoch !== input.expectedRuntimeEpoch) {
      throw new MaintenanceConflict('运行时已更换，请先验证新实例的健康状态。');
    }
    return c.json(
      await leaveMaintenance(database, input.expectedRevision, input.expectedRuntimeEpoch),
    );
  });
