import { readServerConfig } from './config';
import { startServer } from './start';

const config = await readServerConfig();
const server = await startServer({ config });
console.info(
  JSON.stringify({
    event: 'listening',
    buildId: config.buildId,
    url: server.url,
  }),
);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('[shutdown] failed', error);
      process.exit(1);
    },
  );
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
