/**
 * Vite config used only by the E2E harness's UI servers (`tests/support/harness.ts` boots one
 * instance per release identity through Vite's JS API).
 *
 * The file carries the shared product pipeline only (routing, JSX + StyleX — the same pipeline
 * the product build uses, so the browser under test renders exactly what ships). Everything
 * instance-specific is injected inline per boot by the harness:
 *  - the compiled `__SPELLTYPE_RELEASE_ID__` constant (`define`), because release A and release
 *    B UIs run side by side;
 *  - the dependency-optimizer `cacheDir`, isolated per worker and release so the instances
 *    never delete each other's committed caches;
 *  - the `/api` proxies, including the fixture-only Origin mapping to the stable API's
 *    canonical public origin.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { frontendPlugins } from '../vite.frontend.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  plugins: [...frontendPlugins()],
  // The browser under test opts into the real service worker: `src/app/notifications.ts`
  // gates registration on `import.meta.env.PROD || VITE_ENABLE_NOTIFICATIONS_SW === '1'`,
  // and dev servers must stay SW-free by default, so the E2E UI sets the flag here.
  // Merges with the harness's inline per-release `define` (release id) per boot.
  define: { 'import.meta.env.VITE_ENABLE_NOTIFICATIONS_SW': '"1"' },
  optimizeDeps: { holdUntilCrawlEnd: false },
  logLevel: 'info',
});
