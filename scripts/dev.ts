import { createServer, type ViteDevServer } from 'vite';
import { readServerConfig } from '../server/config';
import { startServer } from '../server/start';

const config = await readServerConfig();
if (!config.autoMigrate) throw new Error('Local development requires NODE_ENV=development.');
const backend = await startServer({ config });
const origin = new URL(config.publicOrigin);
let frontend: ViteDevServer;
try {
  frontend = await createServer({
    configLoader: 'native',
    plugins: [
      {
        name: 'spelltype-runtime',
        async closeServer({ reason }) {
          if (reason === 'close') await backend.close();
        },
      },
    ],
    server: {
      host: origin.hostname,
      port: Number(origin.port || 5173),
      strictPort: true,
      proxy: { '/api': { target: backend.url, ws: true } },
    },
  });
  await frontend.listen();
} catch (error) {
  await backend.close();
  throw error;
}
frontend.printUrls();
console.info(`[server] ${backend.url}; database ready before listening.`);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void frontend.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('[dev] shutdown failed', error);
      process.exit(1);
    },
  );
}

// Backend restarts are explicit: Bun --watch does not await PGlite shutdown. Vite owns frontend HMR.
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
