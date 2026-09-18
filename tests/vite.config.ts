/**
 * Vite config used only by the E2E harness (`tests/playwright.config.ts` starts it).
 *
 * Differences from the product config:
 *  - `worker/provider.ts` is aliased to the fixture-backed provider (this file is the
 *    only place that alias exists).
 *  - the Cloudflare plugin runs against a generated per-instance wrangler config whose
 *    D1 database and persist directory are isolated from the developer's local state.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionProvider = path.join(root, 'worker', 'provider.ts');
const fixtureProvider = path.join(root, 'tests', 'support', 'test-provider.ts');

function aliasWorkerProviderToFixture(): Plugin {
  return {
    name: 'e2e-alias-worker-provider',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const importerPath = importer.split('?')[0];
      const resolved = path.resolve(path.dirname(importerPath), source);
      if (resolved === productionProvider || `${resolved}.ts` === productionProvider) return fixtureProvider;
      return null;
    },
  };
}

const configPath = process.env.E2E_WRANGLER_CONFIG;
const persistPath = process.env.E2E_PERSIST_DIR;
const port = Number(process.env.E2E_APP_PORT ?? '');

if (!configPath || !persistPath || !Number.isInteger(port) || port <= 0) {
  throw new Error('E2E vite config requires E2E_WRANGLER_CONFIG, E2E_PERSIST_DIR and E2E_APP_PORT (the harness sets them)');
}

export default defineConfig({
  root,
  plugins: [
    aliasWorkerProviderToFixture(),
    cloudflare({
      configPath,
      persistState: { path: persistPath },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    // The harness writes its D1 files, logs and Playwright traces under tests/.state; the
    // dev server must not react to them with HMR or full page reloads.
    watch: { ignored: ['**/tests/.state/**', '**/.wrangler/**'] },
  },
  logLevel: 'info',
});
