import { join } from 'node:path';
import { Hono } from 'hono';

/** 仅 Vite 基于内容寻址的代码资产是不可变的；public/ 下的文件名可能会被重复使用。 */
const HASHED_ASSET = /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|woff2?)$/;

export function createAssetApp(root: string | null) {
  const app = new Hono();
  if (!root) return app;

  app.get('*', async (c) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.notFound();
    }
    if (
      path === '/api' ||
      path.startsWith('/api/') ||
      path === '/health' ||
      !/^\/[\w./-]*$/.test(path) ||
      path.split('/').some((part) => part.startsWith('.'))
    ) {
      return c.notFound();
    }
    if (path !== '/' && !path.endsWith('/')) {
      const file = Bun.file(join(root, path.slice(1)));
      if (await file.exists()) {
        c.header(
          'Cache-Control',
          HASHED_ASSET.test(path)
            ? 'public, max-age=31536000, immutable'
            : path.endsWith('.html')
              ? 'no-store'
              : 'no-cache',
        );
        if (path === '/sw.js') c.header('Service-Worker-Allowed', '/');
        return new Response(file, { headers: c.res.headers });
      }
    }
    // 缺失的脚本/图片必须返回真实的 404，绝不能用伪装成模块的 HTML 页面替代。
    if (path.startsWith('/assets/') || path.split('/').some((part) => part.includes('.')))
      return c.notFound();
    const index = Bun.file(join(root, 'index.html'));
    if (!(await index.exists())) return c.text('页面暂不可用，请稍后重试。', 503);
    return new Response(index, { headers: c.res.headers });
  });
  return app;
}
