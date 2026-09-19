import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
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
  );
