import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetApp } from '../../server/assets';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assets() {
  const root = await mkdtemp(join(tmpdir(), 'spelltype-assets-'));
  roots.push(root);
  await Promise.all([
    Bun.write(
      join(root, 'index.html'),
      '<!doctype html><html><head><title data-seo>Spelltype</title></head><body><div id="root"></div></body></html>',
    ),
    Bun.write(join(root, 'assets/index-a1b2c3d4.js'), 'export const ready = true;'),
    Bun.write(join(root, 'sw.js'), 'self.addEventListener("install", () => {});'),
    Bun.write(join(root, '.env'), 'PRIVATE_DATA'),
  ]);
  return createAssetApp(root, 'https://practice.example');
}

test('单页应用（SPA）导航和邀请链接返回不缓存的 HTML，哈希代码资源不可变缓存', async () => {
  const app = await assets();
  const page = await app.request('/?room=aaaaaaaaaaaaaaaaaaaaaaaa');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
  expect(page.headers.get('cache-control')).toBe('no-store');
  const code = await app.request('/assets/index-a1b2c3d4.js');
  expect(code.status).toBe(200);
  expect(code.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await code.text()).toBe('export const ready = true;');
  const worker = await app.request('/sw.js');
  expect(worker.headers.get('cache-control')).toBe('no-cache');
  expect(worker.headers.get('service-worker-allowed')).toBe('/');
});

test('缺失的代码块、API 路径和路径穿越请求绝不返回 SPA HTML 或机密信息', async () => {
  const app = await assets();
  for (const path of [
    '/assets/missing.js',
    '/_releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.js',
    '/api',
    '/api/missing',
    '/.env',
    '/assets/..%2f..%2f.env',
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('PRIVATE_DATA');
    expect(response.headers.get('content-type')).not.toContain('text/html');
  }
});

test('公开页面直接提供正文、规范地址与结构化数据，忽略请求主机及跟踪参数', async () => {
  const app = await assets();
  for (const path of ['/', '/guide']) {
    const response = await app.request(`https://untrusted.example${path}?utm_source=share`, {
      headers: { 'X-Forwarded-Host': 'untrusted.example' },
    });
    const document = await response.text();
    expect(response.status).toBe(200);
    expect(document).toMatch(/<h1>[^<]+<\/h1>/);
    expect(document).toMatch(/<li>[^<]+<\/li>/);
    expect(document).toContain(`rel="canonical" href="https://practice.example${path}"`);
    expect(document).not.toContain('untrusted.example');
    expect(document).not.toContain('utm_source');
    expect(document).toContain('name="robots" content="index, follow');
    const json = document.match(
      /<script data-seo type="application\/ld\+json">(.*?)<\/script>/,
    )?.[1];
    expect(JSON.parse(json!)).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': expect.arrayContaining([
        expect.objectContaining({ '@type': 'WebPage', url: `https://practice.example${path}` }),
      ]),
    });
  }
});

test('邀请及账号页面不收录，且不会污染随后访问的公开首页', async () => {
  const app = await assets();
  for (const path of [
    '/?room=aaaaaaaaaaaaaaaaaaaaaaaa',
    '/?error=wechat_failed',
    '/auth',
    '/me',
    '/match',
    '/create',
    '/admin/maintenance',
  ]) {
    const response = await app.request(path);
    const document = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(document).toContain('name="robots" content="noindex, follow"');
    expect(document).not.toContain('application/ld+json');
    expect(document).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
  }
  const home = await app.request('/');
  expect(home.headers.get('x-robots-tag')).toBeNull();
  expect(await home.text()).toContain('name="robots" content="index, follow');
});

test('未知页面返回真实 404；重复入口重定向；站点地图只包含公开页面', async () => {
  const app = await assets();
  const missing = await app.request('/missing-page');
  expect(missing.status).toBe(404);
  expect(missing.headers.get('x-robots-tag')).toBe('noindex, follow');
  expect(await missing.text()).not.toContain('rel="canonical"');
  for (const [path, target] of [
    ['/guide/?utm_source=share', '/guide?utm_source=share'],
    ['/index.html?room=abc', '/?room=abc'],
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(target);
  }
  const sitemap = await app.request('/sitemap.xml');
  expect(sitemap.headers.get('content-type')).toContain('application/xml');
  expect(
    [...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]),
  ).toEqual(['https://practice.example/', 'https://practice.example/guide']);
  const robots = await app.request('/robots.txt');
  expect(robots.headers.get('content-type')).toContain('text/plain');
  expect(await robots.text()).toContain('Sitemap: https://practice.example/sitemap.xml');
});

test('动态管理页支持编码后的主题并保持各自规范地址，不进入公开收录', async () => {
  const app = await assets();
  for (const theme of ['魔法学院', '元素试炼']) {
    const path = `/admin/books/${encodeURIComponent(theme)}`;
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(await response.text()).toContain(
      `rel="canonical" href="https://practice.example${path}"`,
    );
    const trailing = await app.request(`${path}/`);
    expect(trailing.status).toBe(301);
    expect(trailing.headers.get('location')).toBe(path);
  }
});
