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
    Bun.write(join(root, 'index.html'), '<!doctype html><title>Spelltype</title>'),
    Bun.write(join(root, 'assets/index-a1b2c3d4.js'), 'export const ready = true;'),
    Bun.write(join(root, 'sw.js'), 'self.addEventListener("install", () => {});'),
    Bun.write(join(root, '.env'), 'PRIVATE_DATA'),
  ]);
  return createAssetApp(root);
}

test('SPA navigation and invitations get uncached HTML; hashed code is immutable', async () => {
  const app = await assets();
  const page = await app.request('/?room=aaaaaaaaaaaaaaaaaaaaaaaa');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toContain('<title>Spelltype</title>');
  const code = await app.request('/assets/index-a1b2c3d4.js');
  expect(code.status).toBe(200);
  expect(code.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await code.text()).toBe('export const ready = true;');
  const worker = await app.request('/sw.js');
  expect(worker.headers.get('cache-control')).toBe('no-cache');
  expect(worker.headers.get('service-worker-allowed')).toBe('/');
});

test('missing chunks, API paths and path traversal never receive SPA HTML or secrets', async () => {
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
