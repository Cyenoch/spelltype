import { readServerConfig } from './config';
import { startServerUntilOwned, type RunningServer } from './start';

const config = await readServerConfig();

// 信号处理先于启动注册：等待旧租约的交接窗口可能持续数十秒，
// 期间收到 SIGTERM/SIGINT 的替换实例尚未持有任何资源，立即退位让交班进行。
let server: RunningServer | undefined;
let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  if (!server) process.exit(0);
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

server = await startServerUntilOwned({ config });
console.info(
  JSON.stringify({
    event: 'listening',
    buildId: config.buildId,
    url: server.url,
  }),
);
