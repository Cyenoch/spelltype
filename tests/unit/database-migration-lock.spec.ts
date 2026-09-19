/**
 * PostgreSQL 迁移建议锁 —— 用于数据库迁移的跨进程临界区。
 *
 * 每个 api/game 进程在启动时都会调用 `openDatabase`，因此同时启动的两个容器会竞争执行迁移。
 * 此处固化的关键行为包括：获取锁时轮询调用 `pg_try_advisory_lock`（绝不使用无限制阻塞的 `pg_advisory_lock`）；
 * 在达到超时上限后放弃并抛错，错误信息中包含该建议锁键名以便运维排查持有者；释放锁的方式确保绝不掩盖迁移本身的执行结果；
 * 并采用一个符合 PostgreSQL 有符号 bigint 范围的确定性应用专用键。
 */
import { describe, expect, it } from 'bun:test';
import {
  acquireAdvisoryMigrationLock,
  DatabaseMigrationError,
  MIGRATION_ADVISORY_LOCK_KEY,
  type AdvisoryLockQuery,
} from '../../server/db/migrate';

const KEY = MIGRATION_ADVISORY_LOCK_KEY.toString();

interface RecordedCall {
  text: string;
  params: unknown[];
}

/** 桩查询函数，每次调用返回一条预设响应并记录全部调用细节。 */
function stubQuery(responses: Array<unknown[] | Error>): {
  query: AdvisoryLockQuery;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: (text, params) => {
      calls.push({ text, params });
      const next = responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? []);
    },
  };
}

describe('acquireAdvisoryMigrationLock', () => {
  it('在首次空闲尝试时即获取成功，并使用相同的键释放锁', async () => {
    const stub = stubQuery([[{ locked: true }], []]);
    const lock = await acquireAdvisoryMigrationLock(stub.query);

    expect(stub.calls[0]).toEqual({
      text: 'select pg_try_advisory_lock($1) as locked',
      params: [KEY],
    });
    await lock.release();
    expect(stub.calls[1]).toEqual({ text: 'select pg_advisory_unlock($1)', params: [KEY] });
  });

  it('轮询等待持有者释放，而不是使用阻塞式加锁调用挂起', async () => {
    const stub = stubQuery([[{ locked: false }], [{ locked: false }], [{ locked: true }]]);
    const sleeps: number[] = [];
    const lock = await acquireAdvisoryMigrationLock(stub.query, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(stub.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 250]);
    await lock.release();
    expect(stub.calls[3]?.text).toBe('select pg_advisory_unlock($1)');
  });

  it('在达到有界等待时间后放弃并指明建议锁键名', async () => {
    const stub = stubQuery([[{ locked: false }]]);
    let failure: unknown;
    try {
      await acquireAdvisoryMigrationLock(stub.query, {
        waitMs: 40,
        pollMs: 5,
        sleep: () => Promise.resolve(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DatabaseMigrationError);
    expect((failure as Error).message).toContain(KEY);
    expect((failure as Error).message).toContain('waited 40 ms');
    expect(stub.calls.every((call) => call.text.includes('pg_try_advisory_lock'))).toBe(true);
  });

  it('向上传递解锁失败异常，确保异常清理绝不会被误报为正常', async () => {
    const stub = stubQuery([[{ locked: true }], new Error('connection died')]);
    const lock = await acquireAdvisoryMigrationLock(stub.query);
    const failure = await lock.release().catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'connection died' });
    expect(stub.calls[1]).toEqual({ text: 'select pg_advisory_unlock($1)', params: [KEY] });
  });

  it('使用位于 PostgreSQL 有符号 bigint 范围内的应用专属键', () => {
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeGreaterThan(0n);
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeLessThan(2n ** 63n);
  });
});
