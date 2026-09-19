/**
 * 启动组合根的租约交接等待 —— 任何 stop-first 替换（先起新任务、再停旧任务）都会
 * 让新实例在旧所有者的 30s 租约存活期内启动。此处固化的行为决定了这个窗口是
 * 有界等待还是崩溃循环（后者会把短暂交接变成编排器反复重启造成的分钟级 502）：
 *  - 旧所有者释放租约后，等待中的实例立即以递增纪元接管并开始服务；
 *  - 等待窗口耗尽且租约仍被持有时，以 RuntimeOwnershipBusyError 拒绝，且期间确实重试过；
 *  - 非繁忙错误（资产缺失等配置故障）立即上抛，绝不进入等待。
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { readServerConfig, type ServerConfig } from '../../server/config';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import {
  RuntimeOwnershipBusyError,
  acquireRuntime,
  type RuntimeOwnership,
} from '../../server/maintenance/ownership';
import { startServerUntilOwned, type RunningServer } from '../../server/start';

const TIMEOUT = 120_000;
// 每个测试都会启动真实的 WASM Postgres；测试运行器默认的 5 秒超时时间不够。
setDefaultTimeout(TIMEOUT);

const opened: OpenedDatabase[] = [];
const owned: RuntimeOwnership[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close().catch(() => {});
  }
  for (const ownership of owned.splice(0)) {
    await ownership.close().catch(() => {});
  }
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {});
  }
});

/** 统计启动重试发出的 lease_busy 事件；启动日志是等待行为唯一无需 mock 的可观测面。 */
function captureLeaseBusyEvents(): { count(): number; restore(): void } {
  const original = console.info;
  let busyEvents = 0;
  console.info = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === 'string' && arg.includes('"lease_busy"'))) {
      busyEvents += 1;
    }
  };
  return {
    count: () => busyEvents,
    restore: () => {
      console.info = original;
    },
  };
}

/** 所有测试共用的临时端口配置：端口 0 避免与并行测试或开发服务器冲突。 */
async function testConfig(): Promise<ServerConfig> {
  return { ...(await readServerConfig({})), hostname: '127.0.0.1', port: 0 };
}

describe('startServerUntilOwned 租约交接', () => {
  it('等待旧所有者释放租约，随后以递增纪元接管并开始服务', async () => {
    const database = await openDatabase('pglite://:memory:');
    opened.push(database);
    const previous = await acquireRuntime(database.db, { heartbeatMs: 60_000 });
    owned.push(previous);
    const capture = captureLeaseBusyEvents();
    try {
      const bootstrapping = startServerUntilOwned({
        config: await testConfig(),
        database: database.db,
        busyLeaseRetryMs: 20,
        busyLeaseWaitMs: 2_000,
      });
      await Bun.sleep(120);
      expect(capture.count()).toBeGreaterThanOrEqual(1); // 交接未发生：在等待而非退出

      await previous.close(); // 旧所有者主动让位（SIGTERM 路径的真实行为）
      const server = await bootstrapping;
      servers.push(server);

      const health = (await (await fetch(new URL('/health', server.url))).json()) as {
        ok: boolean;
        runtimeEpoch: number;
      };
      expect(health.ok).toBe(true);
      expect(health.runtimeEpoch).toBe(previous.epoch + 1);
    } finally {
      capture.restore();
    }
  });

  it('租约被持续持有时在窗口耗尽后以繁忙错误拒绝', async () => {
    const database = await openDatabase('pglite://:memory:');
    opened.push(database);
    const holder = await acquireRuntime(database.db, { heartbeatMs: 60_000 });
    owned.push(holder);
    const capture = captureLeaseBusyEvents();
    try {
      await rejects(
        startServerUntilOwned({
          config: await testConfig(),
          database: database.db,
          busyLeaseRetryMs: 20,
          busyLeaseWaitMs: 80,
        }),
        RuntimeOwnershipBusyError,
      );
      expect(capture.count()).toBeGreaterThanOrEqual(2); // 确实在重试，而非首次即放弃
    } finally {
      capture.restore();
    }
  });

  it('非繁忙的启动错误立即上抛，绝不等待', async () => {
    const config = {
      ...(await testConfig()),
      assetsRoot: '/nonexistent-spelltype-assets',
    };
    const capture = captureLeaseBusyEvents();
    try {
      await rejects(
        startServerUntilOwned({ config, busyLeaseRetryMs: 50, busyLeaseWaitMs: 5_000 }),
        /Application assets are missing/,
      );
      expect(capture.count()).toBe(0);
    } finally {
      capture.restore();
    }
  });
});
