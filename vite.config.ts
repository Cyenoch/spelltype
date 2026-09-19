import { defineConfig } from 'vite';
import { frontendPlugins } from './vite.frontend.ts';

// The client is always served from the root (`/`) by the single app server;
// there is no per-release base path. SPELLTYPE_BUILD_ID only feeds the
// informational __SPELLTYPE_BUILD_ID__ macro in browser builds; the runtime
// build identity comes from /api/status.
export default defineConfig({
  base: '/',
  define: {
    __SPELLTYPE_BUILD_ID__: JSON.stringify(process.env.SPELLTYPE_BUILD_ID ?? 'development'),
  },
  plugins: frontendPlugins(),
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Persisted state and test evidence must not trigger a live game's browser reload.
    watch: { ignored: ['**/tests/.state/**', '**/.scratch/**', '**/.data/**'] },
  },
});
