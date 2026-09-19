/**
 * The one global runtime ownership lease on real PGlite — where write fencing lives.
 *
 * Pinned here, because these failures corrupt live games:
 *  - acquiring bumps the epoch and claims a lease; a duplicate acquire while the lease is live is
 *    refused as busy, never raced;
 *  - `assert` is the write fence: after the lease lapses or is taken over by a successor, the
 *    old owner's writes throw `RuntimeOwnershipLostError` and fire `onLost` exactly once;
 *  - the heartbeat only RENEWS — a lapsed lease is never resurrected, and a late beat never
 *    extends a successor's lease;
 *  - `close` releases only the owner's own lease, is idempotent, and leaves a successor's lease
 *    untouched;
 *  - the ownership record is durable row state: a "restart" (a fresh acquire after the old lease
 *    died) takes over with a strictly higher epoch, so stale epochs can never win.
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
// Every test here boots a real WASM Postgres; the runner's 5s default is not enough.
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

/** Keeps handles so afterEach stands every heartbeat down, even mid-test-failure. */
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
  it('claims the singleton lease and reports the epoch the row now carries', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { heartbeatMs: 60_000 });

    expect(ownership.epoch).toBe(1);
    const row = await leaseRow(db);
    expect(row.runtime_id).not.toBeNull();
    expect(row.runtime_epoch).toBe(1);
    expect(row.lease_until).toBeGreaterThan(Date.now());
    expect((await inspectMaintenance(db)).runtimeEpoch).toBe(1);
  });

  it('refuses a duplicate acquire while the lease is live, without touching the row', async () => {
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

  it('takes over an expired lease with the next epoch — restart durability', async () => {
    const db = await freshDb();
    await acquire(db, { leaseMs: 40, heartbeatMs: 60_000 });
    await sleep(80); // first owner vanishes without close(); the lease dies on the DB clock

    const successor = await acquire(db, { heartbeatMs: 60_000 });
    expect(successor.epoch).toBe(2);
    const row = await leaseRow(db);
    expect(row.runtime_epoch).toBe(2);
    expect(row.lease_until).toBeGreaterThan(Date.now());
  });
});

describe('the assert write fence', () => {
  it('fences a lapsed owner: the write throws, onLost fires once', async () => {
    const db = await freshDb();
    const lost: number[] = [];
    const ownership = await acquire(db, {
      leaseMs: 40,
      heartbeatMs: 60_000,
      onLost: () => lost.push(ownership.epoch),
    });
    await sleep(80); // lease lapses; the owner does not notice until it tries to write

    let failure: unknown;
    await db.transaction(async (tx) => {
      try {
        await ownership.assert(tx);
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(RuntimeOwnershipLostError);
    // onLost fires from the failed fence, and repeated failed fences stay one signal.
    await db.transaction(async (tx) => ownership.assert(tx).catch(() => {}));
    expect(lost).toEqual([1]);
  });

  it('fences the old owner against a successor takeover', async () => {
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

describe('heartbeat renew-only semantics', () => {
  it('keeps a healthy owner alive past the first lease window', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { leaseMs: 80, heartbeatMs: 20 });
    await sleep(200); // several beats: each renews before the 80ms lease can lapse

    const row = await leaseRow(db);
    expect(row.runtime_id).not.toBeNull();
    expect(row.lease_until).toBeGreaterThan(Date.now());
    await db.transaction(async (tx) => {
      await ownership.assert(tx);
    });
  });

  it('never resurrects a lapsed lease, and never extends a successor’s lease', async () => {
    const db = await freshDb();
    const lost: number[] = [];
    const lapsed = await acquire(db, {
      leaseMs: 40,
      heartbeatMs: 100, // the first beat lands after the 40ms lease has already lapsed
      onLost: () => lost.push(lapsed.epoch),
    });
    await sleep(350); // beat at ~100ms refuses to renew the lapsed lease and fires onLost
    expect(lost).toEqual([1]);

    const rowAfterLoss = await leaseRow(db);
    expect(rowAfterLoss.lease_until).toBeLessThan(Date.now()); // not resurrected

    await acquire(db, { heartbeatMs: 60_000 });
    const successorRow = await leaseRow(db);
    await sleep(300); // any beat after the loss is a no-op; the successor's lease stays intact
    const afterBeat = await leaseRow(db);
    expect(afterBeat.runtime_id).toBe(successorRow.runtime_id); // successor's token untouched
    expect(afterBeat.runtime_epoch).toBe(2);
    expect(afterBeat.lease_until).toBe(successorRow.lease_until); // not extended by the dead beat
  });
});

describe('close', () => {
  it('refuses new writes as soon as close starts, even while lease release is blocked', async () => {
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

  it('releases the lease, keeps the epoch, and is idempotent', async () => {
    const db = await freshDb();
    const ownership = await acquire(db, { heartbeatMs: 60_000 });
    await ownership.close();
    await ownership.close();

    const row = await leaseRow(db);
    expect(row.runtime_id).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.runtime_epoch).toBe(1); // history is never rewritten
  });

  it('never touches a successor’s lease', async () => {
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

  it('gives the next clean start a fresh epoch: a stand-down owner never resumes silently', async () => {
    const db = await freshDb();
    const first = await acquire(db, { heartbeatMs: 60_000 });
    await first.close();
    const second = await acquire(db, { heartbeatMs: 60_000 });
    expect(second.epoch).toBe(2);
  });
});
