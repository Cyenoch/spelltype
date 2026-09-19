/**
 * 真实 PGlite 上的全局运行时所有权租约 —— 实现写入隔离与写屏障的关键。
 *
 * 此处固化的关键行为如下（这些故障会导致线上运行中的对局受损）：
 *  - 获取租约会递增纪元世代并认领租约；在租约有效期间重复获取会被作为繁忙状态拒绝，绝不产生竞态；
 *  - `assert` 构成了写屏障：当租约过期或被后继者接管后，旧所有者的写入操作将抛出 `RuntimeOwnershipLostError`，并精确触发一次 `onLost` 回调；
 *  - 心跳仅用于续租 —— 过期的租约绝不会被心跳复活，且迟到的心跳绝不能延长后继者的租约；
 *  - `close` 仅释放所有者自身的租约，具备幂等性，且绝不影响后继者的租约；
 *  - 所有权记录是持久化的行状态：“重启”（旧租约失效后的重新获取）会以严格递增的世代接管，旧世代绝不可能竞争获胜。
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { openDatabase, runtimeControl, type Database, type OpenedDatabase } from '../../server/db';
import {
  RuntimeOwnershipBusyError,
  RuntimeOwnershipLostError,
  acquireRuntime,
  type RuntimeOwnership,
} from '../../server/maintenance/ownership';
import { inspectMaintenance } from '../../server/maintenance/control';

const TIMEOUT = 120_000;
// 这里的每个测试都会启动真实的 WASM Postgres；测试运行器默认的 5 秒超时时间不够。
setDefaultTimeout(TIMEOUT);

const opened: OpenedDatabase[] = [];
const owned: RuntimeOwnership[] = [];

afterEach(async () => {
  for (const ownership of owned.splice(0)) {
    await ownership.close().catch(() => {});
  }
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {});
  }
});

async function freshDb(): Promise<Database> {
  const openedDb = await openDatabase('pglite://:memory:');
  opened.push(openedDb);
  return openedDb.db;
}

/** 保存实例引用，以便 afterEach 即使在测试失败时也能优雅关闭所有心跳定时器。 */
async function acquire(db: Database, options?: Parameters<typeof acquireRuntime>[1]) {
  const ownership = await acquireRuntime(db, options);
  owned.push(ownership);
  return ownership;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function leaseRow(db: Database) {
  const [row] = await db.select().from(runtimeControl);
  return row;
}

describe('acquireRuntime', () => {
  it('认领单例租约并返回该行当前携带的纪元世代', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { heartbeatMs: 60_000 });

    expect(ownership.epoch).toBe(1);
    const row = await leaseRow(db);
    expect(row.runtime_id).not.toBeNull();
    expect(row.runtime_epoch).toBe(1);
    expect(row.lease_until).toBeGreaterThan(Date.now());
    expect((await inspectMaintenance(db)).runtimeEpoch).toBe(1);
  });

  it('在租约依然有效时拒绝重复获取，且不修改数据行', async () => {
    const db = await freshDb();
    await acquire(db, { heartbeatMs: 60_000 });
    const before = await leaseRow(db);

    const busy = await acquire(db, { heartbeatMs: 60_000 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(busy).toBeInstanceOf(RuntimeOwnershipBusyError);
    expect((busy as RuntimeOwnershipBusyError).retryable).toBe(true);
    expect(await leaseRow(db)).toEqual(before);
  });

  it('以递增世代接管已过期的租约 —— 验证重启的持久性', async () => {
    const db = await freshDb();
    await acquire(db, { leaseMs: 40, heartbeatMs: 60_000 });
    await sleep(80); // 首个所有者在未调用 close() 的情况下消失；租约在数据库时钟上自然死亡

    const successor = await acquire(db, { heartbeatMs: 60_000 });
    expect(successor.epoch).toBe(2);
    const row = await leaseRow(db);
    expect(row.runtime_epoch).toBe(2);
    expect(row.lease_until).toBeGreaterThan(Date.now());
  });
});

describe('assert 写屏障机制', () => {
  it('隔离已失效的所有者：写入抛出异常，onLost 精确触发一次', async () => {
    const db = await freshDb();
    const lost: number[] = [];
    const ownership = await acquire(db, {
      leaseMs: 40,
      heartbeatMs: 60_000,
      onLost: () => lost.push(ownership.epoch),
    });
    await sleep(80); // 租约失效；所有者在尝试执行写操作之前尚未察觉

    let failure: unknown;
    await db.transaction(async (tx) => {
      try {
        await ownership.assert(tx);
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(RuntimeOwnershipLostError);
    // onLost 由屏障校验失败触发，多次重复屏障失败依然只保留单个信号。
    await db.transaction(async (tx) => ownership.assert(tx).catch(() => {}));
    expect(lost).toEqual([1]);
  });

  it('在后继者接管后对旧所有者施加写屏障隔离', async () => {
    const db = await freshDb();
    const old = await acquire(db, { leaseMs: 40, heartbeatMs: 60_000 });
    await sleep(80);
    const successor = await acquire(db, { heartbeatMs: 60_000 });

    await db.transaction(async (tx) => {
      await successor.assert(tx);
      await rejects(old.assert(tx), RuntimeOwnershipLostError);
    });
  });
});

describe('心跳仅续约语义', () => {
  it('保持健康的所有者持续存活并跨越初始租约周期', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { leaseMs: 80, heartbeatMs: 20 });
    await sleep(200); // 多次心跳：每次都在 80ms 租约失效前完成续约

    const row = await leaseRow(db);
    expect(row.runtime_id).not.toBeNull();
    expect(row.lease_until).toBeGreaterThan(Date.now());
    await db.transaction(async (tx) => {
      await ownership.assert(tx);
    });
  });

  it('绝不复活已过期的租约，且绝不延长后继者的租约', async () => {
    const db = await freshDb();
    const lost: number[] = [];
    const lapsed = await acquire(db, {
      leaseMs: 40,
      heartbeatMs: 100, // 首次心跳在 40ms 租约已失效后才到达
      onLost: () => lost.push(lapsed.epoch),
    });
    await sleep(350); // 约 100ms 时到达的心跳拒绝为失效租约续期并触发 onLost
    expect(lost).toEqual([1]);

    const rowAfterLoss = await leaseRow(db);
    expect(rowAfterLoss.lease_until).toBeLessThan(Date.now()); // 未被复活

    await acquire(db, { heartbeatMs: 60_000 });
    const successorRow = await leaseRow(db);
    await sleep(300); // 失去所有权后的任何心跳均为空操作；后继者的租约保持完好
    const afterBeat = await leaseRow(db);
    expect(afterBeat.runtime_id).toBe(successorRow.runtime_id); // 后继者的 token 未受影响
    expect(afterBeat.runtime_epoch).toBe(2);
    expect(afterBeat.lease_until).toBe(successorRow.lease_until); // 未被已死的心跳延期
  });
});

describe('close 关闭逻辑', () => {
  it('在 close 开始执行后立即拒绝新写入，即便租约释放仍在阻塞中', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { heartbeatMs: 60_000 });
    let closing: Promise<void> | undefined;
    try {
      await db.transaction(async (tx) => {
        await ownership.assert(tx);
        closing = ownership.close();
        await rejects(ownership.assert(tx), RuntimeOwnershipLostError);
      });
    } finally {
      await closing;
    }
  });

  it('释放租约，保留纪元历史，且具备幂等性', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { heartbeatMs: 60_000 });
    await ownership.close();
    await ownership.close();

    const row = await leaseRow(db);
    expect(row.runtime_id).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.runtime_epoch).toBe(1); // 历史纪元从不重写
  });

  it('绝不改动后继者的租约', async () => {
    const db = await freshDb();
    const old = await acquire(db, { leaseMs: 40, heartbeatMs: 60_000 });
    await sleep(80);
    const successor = await acquire(db, { heartbeatMs: 60_000 });

    await old.close();
    const row = await leaseRow(db);
    expect(row.runtime_id).not.toBeNull();
    expect(row.runtime_epoch).toBe(successor.epoch);
    expect(row.lease_until).toBeGreaterThan(Date.now());
  });

  it('为下一次正常启动分配全新纪元：主动退出的所有者绝不静默恢复', async () => {
    const db = await freshDb();
    const first = await acquire(db, { heartbeatMs: 60_000 });
    await first.close();
    const second = await acquire(db, { heartbeatMs: 60_000 });
    expect(second.epoch).toBe(2);
  });
});
