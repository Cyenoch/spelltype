/**
 * Durable maintenance control — the whole admission/drain/resume story on a real database.
 *
 * Pinned here, because a regression in any of them silently breaks deployments:
 *  - the cutover migration seeds `open` on a fresh install and `draining` on a legacy database,
 *    refuses an unsafe legacy cutover (active matches, live reservations, unsettled results, live
 *    old-runtime leases) BEFORE any DDL runs, and preserves user data either way;
 *  - `enterMaintenance`/`leaveMaintenance` are revision CASes that refuse stale and repeated
 *    operations instead of taking over silently;
 *  - resuming (`leaveMaintenance`) requires a live lease AND the caller's proof of which runtime
 *    generation it observed — a stale operator must not reopen maintenance under a successor;
 *  - admission fails closed when draining, and the drain barrier counts exactly the work that
 *    must finish (active matches, live reservations, waiting tickets, unsettled results) while
 *    ignoring idle lobbies, and `ready` stays false while the runtime state is unknown.
 */
import { eq } from 'drizzle-orm';
import { rejects } from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleForPglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  accounts,
  matchTickets,
  openDatabase,
  rooms,
  runtimeControl,
  schema,
  type Database,
  type OpenedDatabase,
} from '../../server/db';
import { MaintenanceError } from '../../shared/maintenance';
import {
  MaintenanceConflict,
  assertAdmission,
  enterMaintenance,
  inspectMaintenance,
  leaveMaintenance,
  readMaintenance,
  withAdmission,
} from '../../server/maintenance/control';

const DRIZZLE_DIR = path.resolve(import.meta.dir, '../../drizzle');
const NOW = 1_700_000_000_000;
const TIMEOUT = 120_000;
// Every test here boots a real WASM Postgres; the runner's 5s default is not enough.
setDefaultTimeout(TIMEOUT);

const opened: OpenedDatabase[] = [];
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {});
  }
  await Promise.all(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  );
});

/** A fresh, fully-migrated in-memory database — the "new install" shape. */
async function freshDb(): Promise<Database> {
  const openedDb = await openDatabase('pglite://:memory:');
  opened.push(openedDb);
  return openedDb.db;
}

async function insertAccount(db: Database, id: string): Promise<void> {
  await db
    .insert(accounts)
    .values({ id, username: `user-${id}`, wechat_identity: `union:${id}`, created_at: NOW });
}

async function insertWaitingTicket(db: Database, userId: string): Promise<void> {
  await db.insert(matchTickets).values({
    user_id: userId,
    request_id: `req-${userId}`,
    username: `user-${userId}`,
    state: 'waiting',
    expires_at: NOW + 60_000,
    created_at: NOW,
    updated_at: NOW,
  });
}

interface RoomSeed {
  id: string;
  phase: 'lobby' | 'generating' | 'countdown' | 'playing' | 'finished';
  reservationState?: 'none' | 'reserved';
  reservationExpiresAt?: number;
  persistence?: 'idle' | 'saving' | 'saved' | 'error';
}

async function insertRoom(db: Database, seed: RoomSeed): Promise<void> {
  await db.insert(rooms).values({
    id: seed.id,
    host_id: 'host',
    mode: 'quick',
    theme: 'autumn',
    difficulty: 'hard',
    phase: seed.phase,
    reservation_state: seed.reservationState ?? 'none',
    reservation_expires_at: seed.reservationExpiresAt ?? null,
    persistence: seed.persistence ?? 'idle',
    created_at: NOW,
    updated_at: NOW,
  });
}

/** Pretends a runtime owns the lease right now (epochs are plain integers on the row). */
async function holdLease(db: Database, epoch: number, leaseInMs = 60_000): Promise<void> {
  await db.update(runtimeControl).set({
    runtime_id: `runtime-${epoch}`,
    runtime_epoch: epoch,
    lease_until: Date.now() + leaseInMs,
  });
}

/**
 * One temp migrations folder containing ONLY the immutable baseline, so a test can migrate to the
 * legacy release-era schema, seed it, and then run the real 0001 cutover on top.
 */
async function stageLegacyMigrationsFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'spelltype-legacy-migrations-'));
  cleanupPaths.push(dir);
  await mkdir(path.join(dir, 'meta'), { recursive: true });
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  );
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx === 0);
  const tag = journal.entries[0].tag as string;
  await writeFile(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  await copyFile(path.join(DRIZZLE_DIR, `${tag}.sql`), path.join(dir, `${tag}.sql`));
  return dir;
}

/** A legacy release-era room row on the 0000 schema. */
function legacyRoomSql(id: string, extraColumns = '', extraValues = ''): string {
  return [
    `insert into rooms (id, release_id, host_id, mode, theme, difficulty, phase, created_at, updated_at${extraColumns ? `, ${extraColumns}` : ''})`,
    `values ('${id}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'host', 'quick', 'autumn', 'hard', 'lobby', 1700000000000, 1700000000000${extraValues});`,
  ].join(' ');
}

/**
 * The legacy fixtures share an account and an active release version; every scenario adds its
 * own rows on the OLD schema (raw SQL — the release tables are gone from the current schema).
 */
function legacySeed(blockers: string): string {
  return [
    `insert into accounts (id, username, wechat_identity, created_at) values ('legacy-user', '旧用户', 'union:legacy-user', ${NOW});`,
    `insert into release_versions (id, state, artifact_digest, operation_id, created_at, updated_at) values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'active', 'digest', 'op', ${NOW}, ${NOW});`,
    blockers,
  ].join('\n');
}

/**
 * A legacy release-era database: migrated to 0000 only, then seeded. The real cutover (the repo's
 * drizzle folder) is applied by the caller — success asserts the new state, refusal asserts the
 * guard.
 */
async function openLegacyDb(seedSql: string): Promise<{
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
}> {
  // No argument: a genuinely throwaway in-process instance. (A ':memory:' string would be
  // treated as a persistent data DIRECTORY — the URL parser's `pglite-memory` driver is what
  // maps that spelling to this same no-argument construction in product code.)
  const client = new PGlite();
  const db = drizzleForPglite(client, { schema });
  await migratePglite(db, { migrationsFolder: await stageLegacyMigrationsFolder() });
  await client.exec(seedSql);
  return { client, db };
}

/** Runs the real cutover against a legacy database, returning the failure (if any). */
function runCutover(db: PgliteDatabase<typeof schema>): Promise<Error | null> {
  return migratePglite(db, { migrationsFolder: DRIZZLE_DIR }).then(
    () => null,
    (error: unknown) => error as Error,
  );
}

describe('cutover migration seeding and guards', () => {
  it('seeds a fresh empty install open for development', async () => {
    const db = await freshDb();
    const info = await readMaintenance(db);
    expect(info).toEqual({ mode: 'open', revision: 0, updatedAt: expect.any(Number) });
  });

  it('seeds a legacy cutover draining, preserves user data and promotes the designated admin', async () => {
    const { client, db } = await openLegacyDb(
      legacySeed(
        legacyRoomSql('a00000000000000000000007', 'persistence', ", 'saved'") +
          ` update rooms set phase = 'finished' where id = 'a00000000000000000000007';` +
          // The operator-designated management identity — management is a WeChat session
          // role, so the cutover itself must promote this existing account exactly once.
          ` insert into accounts (id, username, wechat_identity, created_at) values ('operator', '运维', 'union:omBLS6xCiew0470A53hBYx0mzCbw', ${NOW});`,
      ),
    );
    expect(await runCutover(db)).toBeNull();

    const mode = await client.query<{ mode: string }>(
      'select mode from runtime_control where singleton = 1',
    );
    expect(mode.rows[0]?.mode).toBe('draining');
    const kept = await client.query<{ users: number; finished: number }>(
      "select (select count(*) from accounts) as users, (select count(*) from rooms where phase = 'finished' and persistence = 'saved') as finished",
    );
    expect(kept.rows[0]).toEqual({ users: 2, finished: 1 });
    // Role assignment: the designated identity is admin, every other account stays user.
    const roles = await client.query<{ admins: number; plain: number }>(
      "select (select count(*) from accounts where role = 'admin') as admins, (select count(*) from accounts where role = 'user') as plain",
    );
    expect(roles.rows[0]).toEqual({ admins: 1, plain: 1 });
    const gone = await client.query<{ present: boolean }>(
      "select to_regclass('public.release_versions') is not null as present",
    );
    expect(gone.rows[0]?.present).toBe(false);
    await client.close();
  });

  const refusals = [
    {
      name: 'an active match',
      seed: legacySeed(
        `${legacyRoomSql('a00000000000000000000008')} update rooms set phase = 'playing' where id = 'a00000000000000000000008';`,
      ),
      phrase: '进行中的对局',
      rooms: 1,
    },
    {
      name: 'a live reservation',
      seed: legacySeed(
        legacyRoomSql(
          'a00000000000000000000009',
          'reservation_state, reservation_expires_at',
          ", 'reserved', (extract(epoch from clock_timestamp()) * 1000 + 60000)::bigint",
        ),
      ),
      phrase: '预约席位',
      rooms: 1,
    },
    {
      name: 'an unsettled result',
      seed: legacySeed(
        legacyRoomSql('a00000000000000000000005', 'persistence', ", 'saving'") +
          ` update rooms set phase = 'finished' where id = 'a00000000000000000000005';`,
      ),
      phrase: '战绩未落定',
      rooms: 1,
    },
    {
      name: 'a live old-runtime lease',
      seed: legacySeed(
        `update release_versions set runtime_id = 'old-runtime', runtime_epoch = 3, lease_until = (extract(epoch from clock_timestamp()) * 1000 + 60000)::bigint;`,
      ),
      phrase: '旧运行时租约',
      rooms: 0,
    },
  ];
  for (const { name, seed, phrase, rooms } of refusals) {
    it(`refuses legacy cutover with ${name} and touches nothing`, async () => {
      const { client, db } = await openLegacyDb(seed);
      const failure = await runCutover(db);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain('迁移中止');
      expect(failure?.message).toContain(phrase);
      // Refusal means refusal: the legacy schema and every row are exactly as before.
      const intact = await client.query<{ versions: number; rooms: number; users: number }>(
        'select (select count(*) from release_versions) as versions, (select count(*) from rooms) as rooms, (select count(*) from accounts) as users',
      );
      expect(intact.rows[0]).toEqual({ versions: 1, rooms, users: 1 });
      await client.close();
    });
  }
});

describe('database open migration-level policy', () => {
  /** A throwaway PGlite FILE directory — required because `migrate: false` reopens it. */
  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-policy-'));
    cleanupPaths.push(dir);
    return dir;
  }

  /**
   * A folder derived from the shipped one: `ahead` adds a future migration;
   * `diverged` rewrites the newest file (same SQL semantics, different hash).
   */
  async function stageDerivedMigrationsFolder(kind: 'ahead' | 'diverged'): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), `spelltype-${kind}-migrations-`));
    cleanupPaths.push(dir);
    await mkdir(path.join(dir, 'meta'), { recursive: true });
    const journal = JSON.parse(
      await readFile(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
    );
    for (const entry of journal.entries) {
      await copyFile(
        path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
        path.join(dir, `${entry.tag}.sql`),
      );
    }
    if (kind === 'ahead') {
      const last = journal.entries[journal.entries.length - 1];
      journal.entries.push({
        idx: last.idx + 1,
        version: '7',
        when: last.when + 1_000,
        tag: 'future_build_marker',
        breakpoints: true,
      });
      await writeFile(
        path.join(dir, 'future_build_marker.sql'),
        'CREATE TABLE "ahead_marker" ("id" integer NOT NULL);',
      );
    } else {
      const last = journal.entries[journal.entries.length - 1];
      await writeFile(
        path.join(dir, `${last.tag}.sql`),
        (await readFile(path.join(DRIZZLE_DIR, `${last.tag}.sql`), 'utf8')) + '\n-- rewritten\n',
      );
    }
    await writeFile(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
    return dir;
  }

  it('accepts an ahead database whose shipped prefix matches exactly — rollback stays possible', async () => {
    const dataDir = await tempDataDir();
    const url = `pglite://${dataDir}`;
    const ahead = await openDatabase(url, {
      migrationsFolder: await stageDerivedMigrationsFolder('ahead'),
    });
    await ahead.close();

    // An older image (this build) opening the newer schema: the prefix it knows matches, so
    // compatible rollback must succeed — there are no down-migrations.
    for (const migrate of [false, true]) {
      const rolledBack = await openDatabase(url, { migrate });
      try {
        expect(await readMaintenance(rolledBack.db)).toMatchObject({ mode: 'open' });
      } finally {
        await rolledBack.close();
      }
    }
  });

  it('rejects missing migrations in read-only mode and automatically upgrades by default', async () => {
    const dataDir = await tempDataDir();
    const url = `pglite://${dataDir}`;
    const legacy = await openDatabase(url, {
      migrationsFolder: await stageLegacyMigrationsFolder(),
    });
    await legacy.close();

    await rejects(async () => {
      opened.push(await openDatabase(url, { migrate: false }));
    }, Error);
    const upgraded = await openDatabase(url);
    opened.push(upgraded);
    expect(await readMaintenance(upgraded.db)).toMatchObject({ mode: 'open' });
  });

  it('refuses an open whose expected migration hash diverges', async () => {
    const dataDir = await tempDataDir();
    const url = `pglite://${dataDir}`;
    const diverged = await openDatabase(url, {
      migrationsFolder: await stageDerivedMigrationsFolder('diverged'),
    });
    await diverged.close();

    for (const migrate of [false, true]) {
      await rejects(async () => {
        opened.push(await openDatabase(url, { migrate }));
      }, Error);
    }
  });
});

describe('enterMaintenance and leaveMaintenance revision CAS', () => {
  it('enters draining, bumps the revision and deletes waiting tickets exactly once', async () => {
    const db = await freshDb();
    await insertAccount(db, 'queue-user');
    await insertWaitingTicket(db, 'queue-user');

    const info = await enterMaintenance(db, 0);
    expect(info).toEqual({ mode: 'draining', revision: 1, updatedAt: expect.any(Number) });
    expect(await db.select().from(matchTickets)).toEqual([]);

    // A repeated operation is refused even with the now-current revision — nobody re-enters.
    const repeat = await enterMaintenance(db, info.revision).then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeat).toBeInstanceOf(MaintenanceConflict);
    expect(await readMaintenance(db)).toMatchObject({ mode: 'draining', revision: 1 });
  });

  it('refuses a stale revision without changing anything', async () => {
    const db = await freshDb();
    const stale = await enterMaintenance(db, 7).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(MaintenanceConflict);
    expect(await readMaintenance(db)).toMatchObject({ mode: 'open', revision: 0 });
  });

  it('resumes only for the observed runtime generation holding a live lease', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);
    await holdLease(db, 3);

    // The happy resume quotes exactly the revision and runtime epoch the operator observed.
    const resumed = await leaveMaintenance(db, drained.revision, 3);
    expect(resumed).toEqual({ mode: 'open', revision: 2, updatedAt: expect.any(Number) });

    // Repeating a resume (already open) is refused like any stale operation.
    const repeat = await leaveMaintenance(db, resumed.revision, 3).then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeat).toBeInstanceOf(MaintenanceConflict);
  });

  it('refuses resume without a lease, with a lapsed lease, or against a successor epoch', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);

    // No runtime ever claimed the lease: nothing can vouch for a healthy server. Fail closed.
    const noLease = await leaveMaintenance(db, drained.revision, 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(noLease).toBeInstanceOf(MaintenanceConflict);
    expect((noLease as Error).message).toContain('租约');

    await holdLease(db, 2, -1_000); // lapsed on the wall clock the database compares against
    const lapsed = await leaveMaintenance(db, drained.revision, 2).then(
      () => null,
      (error: unknown) => error,
    );
    expect(lapsed).toBeInstanceOf(MaintenanceConflict);

    // A live lease held by a DIFFERENT generation than the operator observed: the stale
    // operator must not reopen maintenance under a successor it never inspected.
    await holdLease(db, 4);
    const successor = await leaveMaintenance(db, drained.revision, 2).then(
      () => null,
      (error: unknown) => error,
    );
    expect(successor).toBeInstanceOf(MaintenanceConflict);
    expect((successor as Error).message).toContain('第 4 代');
    expect(await readMaintenance(db)).toMatchObject({ mode: 'draining', revision: 1 });
  });

  it('refuses resume against a stale revision', async () => {
    const db = await freshDb();
    await enterMaintenance(db, 0);
    await holdLease(db, 1);
    const stale = await leaveMaintenance(db, 9, 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(MaintenanceConflict);
    expect(await readMaintenance(db)).toMatchObject({ mode: 'draining', revision: 1 });
  });
});

describe('durable admission', () => {
  it('admits while open and commits the callback inside the admission transaction', async () => {
    const db = await freshDb();
    const result = await withAdmission(db, async (tx) => {
      const info = await readMaintenance(tx);
      return { mode: info.mode, controlRows: (await tx.select().from(runtimeControl)).length };
    });
    expect(result.mode).toBe('open');
    expect(result.controlRows).toBe(1);
  });

  it('fails closed with maintenance:draining once draining', async () => {
    const db = await freshDb();
    await enterMaintenance(db, 0);
    let observed: unknown;
    await db.transaction(async (tx) => {
      try {
        await assertAdmission(tx);
      } catch (error) {
        observed = error;
      }
    });
    expect(observed).toBeInstanceOf(MaintenanceError);
    expect((observed as MaintenanceError).code).toBe('maintenance:draining');
    expect((observed as MaintenanceError).status).toBe(503);
  });
});

describe('drain barrier inspection', () => {
  it('counts exactly the blocking work and ignores idle lobbies', async () => {
    const db = await freshDb();
    await insertAccount(db, 'queued');
    await insertWaitingTicket(db, 'queued');
    await insertRoom(db, { id: 'a00000000000000000000001', phase: 'playing' });
    await insertRoom(db, { id: 'a00000000000000000000002', phase: 'generating' });
    await insertRoom(db, { id: 'a00000000000000000000003', phase: 'lobby' });
    await insertRoom(db, {
      id: 'a00000000000000000000004',
      phase: 'lobby',
      reservationState: 'reserved',
      reservationExpiresAt: Date.now() + 60_000,
    });
    await insertRoom(db, {
      id: 'a00000000000000000000005',
      phase: 'finished',
      persistence: 'saving',
    });
    await insertRoom(db, {
      id: 'a00000000000000000000006',
      phase: 'finished',
      persistence: 'saved',
    });

    const drained = await enterMaintenance(db, 0);
    // Entering deletes waiting tickets; a late arrival is counted like any other.
    await insertWaitingTicket(db, 'queued');

    const status = await inspectMaintenance(db);
    expect(status).toEqual({
      mode: 'draining',
      revision: drained.revision,
      updatedAt: expect.any(Number),
      activeMatches: 2, // playing + generating; the idle lobby is not a blocker
      liveReservations: 1,
      waitingTickets: 1,
      pendingResults: 1,
      runtimeKnown: true, // no owner is known state
      runtimeEpoch: 0,
      ready: false,
    });

    // Expired reservations stop blocking without anyone cleaning them up.
    await db
      .update(rooms)
      .set({ reservation_expires_at: Date.now() - 1_000 })
      .where(eq(rooms.id, 'a00000000000000000000004'));
    const afterExpiry = await inspectMaintenance(db);
    expect(afterExpiry.liveReservations).toBe(0);
  });

  it('reports ready only when drained, clear and runtime-known', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);
    expect((await inspectMaintenance(db)).ready).toBe(true);

    // Unknown runtime state (lapsed lease without graceful release) blocks readiness even with
    // zero work, and surfaces the epoch the resume proof must quote.
    await holdLease(db, 5, -1_000);
    const unknown = await inspectMaintenance(db);
    expect(unknown.runtimeKnown).toBe(false);
    expect(unknown.runtimeEpoch).toBe(5);
    expect(unknown.ready).toBe(false);

    await holdLease(db, 6);
    const known = await inspectMaintenance(db);
    expect(known.runtimeKnown).toBe(true);
    expect(known.runtimeEpoch).toBe(6);
    expect(known.ready).toBe(true);
    expect(known.revision).toBe(drained.revision);

    // Open mode is never ready — ready is a drain verdict.
    await leaveMaintenance(db, drained.revision, 6);
    expect((await inspectMaintenance(db)).ready).toBe(false);
  });
});
