import { Hono } from 'hono';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { WS_PROTOCOL } from '../../shared/protocol';
import type { ServiceStatus } from '../../shared/maintenance';
import type { ServerServices } from '../contracts';
import { readMaintenance } from '../maintenance/control';
import { accountRoutes } from './accounts';
import { adminRoutes } from './admin';
import { automationRoutes } from './automation';
import { gameRoutes } from './game';
import {
  apiBodyLimit,
  apiOnError,
  assertRuntimeHealthy,
  noStore,
  requireRuntime,
  type HttpEnv,
} from './context';
import { authRateLimits, createAuthRateLimiter } from './rate-limit';

/** 服务实例与节流窗口归属于具体的应用实例，而非路由模板。 */
export function createApp(services: ServerServices) {
  const app = new Hono<HttpEnv>({ strict: false });
  const limiter = createAuthRateLimiter(authRateLimits(services.config));
  app.use('*', (c, next) => {
    c.set('services', services);
    c.set('limiter', limiter);
    return next();
  });
  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: (c, methods) =>
        c.json({ error: '请求方法不被支持' }, 405, { Allow: methods.join(', ') }),
    }),
  );
  app.onError(apiOnError);
  app.notFound((c) => c.json({ error: '接口不存在' }, 404));
  return app.route('/', publicRoutes);
}

const publicRoutes = new Hono<HttpEnv>({ strict: false })
  .use('/api/*', apiBodyLimit, noStore)
  .get('/health', noStore, async (c) => {
    await assertRuntimeHealthy(c);
    return c.json({
      ok: true as const,
      buildId: c.get('services').config.buildId,
      protocolVersion: WS_PROTOCOL,
      runtimeEpoch: requireRuntime(c).runtimeEpoch,
    });
  })
  .get('/api/status', async (c) => {
    await assertRuntimeHealthy(c);
    const { database, config } = c.get('services');
    const body: ServiceStatus = {
      maintenance: await readMaintenance(database),
      protocolVersion: WS_PROTOCOL,
      buildId: config.buildId,
    };
    return c.json(body);
  })
  .route('/api', accountRoutes)
  .route('/api', gameRoutes)
  .route('/api/admin', adminRoutes)
  .route('/api/ops', automationRoutes);

export type AppType = typeof publicRoutes;
