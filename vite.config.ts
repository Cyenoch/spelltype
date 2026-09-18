import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { frontendPlugins } from './vite.frontend.ts';

export default defineConfig({
  plugins: [...frontendPlugins(), cloudflare()],
  server: {
    port: 5173,
    strictPort: true,
    /**
     * QA artifacts and scratch output are not application input. A suite writing a trace under
     * `tests/.state` — or any tool dropping a file in `.scratch` — otherwise triggers a full page
     * reload of the running app, which is indistinguishable from a spontaneous reconnect of a live
     * match. Only those two trees are ignored: source, assets, config and public edits still reload,
     * and Vite keeps its own defaults (`.git`, `node_modules`, `test-results`, its cache dir), because
     * user patterns are appended to them rather than replacing them.
     */
    watch: { ignored: ['**/tests/.state/**', '**/.scratch/**'] },
  },
});
