import { join } from 'node:path';
import { Hono } from 'hono';
import { escapeHtml, INDEXABLE_PATHS, pageSeo, renderSeoHead } from '../shared/seo';
import { renderPublicContent } from './seo';

/** 仅 Vite 基于内容寻址的代码资产是不可变的；public/ 下的文件名可能会被重复使用。 */
const HASHED_ASSET = /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|woff2?)$/;

export function createAssetApp(root: string | null, publicOrigin: string) {
  const app = new Hono();
  if (!root) return app;

  app.get('/robots.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\n\nSitemap: ${publicOrigin}/sitemap.xml\n`,
    );
  });
  app.get('/sitemap.xml', (c) => {
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${INDEXABLE_PATHS.map((path) => `<url><loc>${escapeHtml(new URL(path, publicOrigin).href)}</loc></url>`).join('')}</urlset>`,
    );
  });

  // 只缓存首页与教程；动态管理页不按玩家、对局或主题 ID 积累文档。
  const documents = new Map<string, Promise<string>>();

  app.get('*', async (c) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.notFound();
    }
    const url = new URL(c.req.url);
    const seo = pageSeo(path, url.search);
    if (
      path === '/api' ||
      path.startsWith('/api/') ||
      path === '/health' ||
      (!seo.known && !/^\/[\w./-]*$/.test(path)) ||
      path.split('/').some((part) => part.startsWith('.'))
    ) {
      return c.notFound();
    }
    if (path === '/index.html') return c.redirect(`/${new URL(c.req.url).search}`, 301);
    if (seo.known && path !== seo.path)
      return c.redirect(`${new URL(seo.path, publicOrigin).pathname}${url.search}`, 301);
    if (!seo.known && path !== '/' && !path.endsWith('/')) {
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
    if (
      !seo.known &&
      (path.startsWith('/assets/') || path.split('/').some((part) => part.includes('.')))
    )
      return c.notFound();
    const index = Bun.file(join(root, 'index.html'));
    if (!(await index.exists())) return c.text('页面暂不可用，请稍后重试。', 503);
    c.header('Content-Type', 'text/html; charset=utf-8');
    if (!seo.indexable) c.header('X-Robots-Tag', 'noindex, follow');
    let document = seo.indexable ? documents.get(seo.path) : undefined;
    if (!document) {
      document = new HTMLRewriter()
        .on('[data-seo]', {
          element: (element) => {
            element.remove();
          },
        })
        .on('head', {
          element: (element) => {
            element.append(
              `<meta name="site-origin" content="${escapeHtml(publicOrigin)}">${renderSeoHead(seo, publicOrigin)}`,
              { html: true },
            );
          },
        })
        .on('#root', {
          element: (element) => {
            element.setInnerContent(renderPublicContent(seo), { html: true });
          },
        })
        .transform(new Response(index))
        .text();
      if (seo.indexable) {
        documents.set(seo.path, document);
        void document.catch(() => documents.delete(seo.path));
      }
    }
    return c.body(await document, seo.known ? 200 : 404);
  });
  return app;
}
