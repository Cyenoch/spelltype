/**
 * The PostgreSQL migration advisory lock — the cross-process critical section for migrations.
 *
 * Every api/game process calls `openDatabase` at boot, so two containers starting together race
 * for the migration. Pinned here: acquisition polls `pg_try_advisory_lock` (never an unbounded
 * `pg_advisory_lock`), gives up after a bounded wait with the advisory key in the error so an
 * operator can find the holder, releases in a way that can never mask the migration's own outcome,
 * and uses one deterministic app-specific key that fits PostgreSQL's signed bigint.
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

/** A stub query function returning one canned response per call, recording everything. */
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
  it('acquires on the first free attempt and unlocks with the same key', async () => {
    const stub = stubQuery([[{ locked: true }], []]);
    const lock = await acquireAdvisoryMigrationLock(stub.query);

    expect(stub.calls[0]).toEqual({
      text: 'select pg_try_advisory_lock($1) as locked',
      params: [KEY],
    });
    await lock.release();
    expect(stub.calls[1]).toEqual({ text: 'select pg_advisory_unlock($1)', params: [KEY] });
  });

  it('polls until the holder leaves instead of waiting on a blocking lock call', async () => {
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

  it('gives up after the bounded wait and names the advisory key', async () => {
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

  it('propagates unlock failures so a dirty cleanup is never reported healthy', async () => {
    const stub = stubQuery([[{ locked: true }], new Error('connection died')]);
    const lock = await acquireAdvisoryMigrationLock(stub.query);
    const failure = await lock.release().catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'connection died' });
    expect(stub.calls[1]).toEqual({ text: 'select pg_advisory_unlock($1)', params: [KEY] });
  });

  it('uses one app-specific key inside PostgreSQL signed bigint range', () => {
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeGreaterThan(0n);
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeLessThan(2n ** 63n);
  });
});
