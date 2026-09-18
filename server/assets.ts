import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { releaseIdSchema } from '../shared/release';
import type { ServerServices } from './contracts';
import { releaseVersions, rooms } from './db/schema';
import { getReleaseInfo } from './releases/control';

const ROOM_ID = /^[0-9a-f]{24}$/;
const ROOT_ASSETS: Record<string, true> = {
  '/sw.js': true,
  '/manifest.webmanifest': true,
  '/apple-touch-icon.png': true,
  '/icons/app-192.png': true,
  '/icons/app-512.png': true,
};

function unavailablePage(message: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>咒文对决</title><body><main><h1>咒文对决</h1><p>${message}</p><a href="/">返回首页</a></main></body></html>`;
}

/** Bun streams the file without materializing its contents in JavaScript. */
async function sendFile(
  context: Context,
  root: string,
  filename: string,
): Promise<Response | null> {
  const file = Bun.file(join(root, filename));
  if (!(await file.exists())) return null;
  return new Response(file, { headers: context.res.headers });
}

/** assetsRoot contains immutable <releaseId>/ directories, including each build's index.html. */
export function createAssetApp({ database, config }: ServerServices) {
  const app = new Hono();
  const root = config.assetsRoot;
  if (!root) return app;

  app.use('*', async (context, next) => {
    context.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.onError((error, context) => {
    console.error(
      '[assets] release lookup failed',
      error instanceof Error ? error.name : typeof error,
    );
    context.header('Cache-Control', 'no-store');
    return context.html(unavailablePage('服务暂不可用，请稍后重试。'), 503);
  });

  app.get('/_releases/:releaseId/*', async (context) => {
    const release = releaseIdSchema.safeParse(context.req.param('releaseId'));
    if (!release.success) return context.notFound();
    const suffix = context.req.path.slice(`/_releases/${release.data}/`.length);
    if (
      !suffix ||
      !/^[\w./-]+$/.test(suffix) ||
      suffix.split('/').some((part) => !part || part.startsWith('.'))
    ) {
      return context.notFound();
    }
    context.header(
      'Cache-Control',
      suffix.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    );
    const response = await sendFile(context, root, `${release.data}/${suffix}`);
    if (response) return response;
    context.header('Cache-Control', 'no-store');
    return context.text('该版本资源不存在或已过期。', 404);
  });

  app.get('*', async (context) => {
    const path = context.req.path;
    if (path.startsWith('/api/') || path.startsWith('/_releases/') || path.startsWith('/assets/')) {
      return context.notFound();
    }
    context.header('Cache-Control', 'no-store');
    if (Object.hasOwn(ROOT_ASSETS, path)) {
      const release = await getReleaseInfo(database);
      if (path === '/sw.js') context.header('Service-Worker-Allowed', '/');
      return (
        (await sendFile(context, root, `${release.activeReleaseId}${path}`)) ?? context.notFound()
      );
    }
    if (path.split('/').some((part) => part.includes('.'))) return context.notFound();

    let releaseId: string;
    const roomId = context.req.query('room');
    if (roomId !== undefined) {
      if (!ROOM_ID.test(roomId)) return context.html(unavailablePage('房间地址无效。'), 400);
      const [location] = await database
        .select({ releaseId: rooms.release_id, state: releaseVersions.state })
        .from(rooms)
        .innerJoin(releaseVersions, eq(rooms.release_id, releaseVersions.id))
        .where(eq(rooms.id, roomId))
        .limit(1);
      if (!location) return context.html(unavailablePage('房间不存在。'), 404);
      if (location.state === 'retired') {
        return context.html(unavailablePage('这个房间所在的版本已退休，无法继续加入。'), 410);
      }
      releaseId = location.releaseId;
    } else {
      releaseId = (await getReleaseInfo(database)).activeReleaseId;
    }
    context.header('X-Spelltype-Release', releaseId);
    return (
      (await sendFile(context, root, `${releaseId}/index.html`)) ??
      context.html(unavailablePage('该版本页面暂不可用，请稍后重试。'), 503)
    );
  });
  return app;
}
