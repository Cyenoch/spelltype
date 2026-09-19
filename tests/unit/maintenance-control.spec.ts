/**
 * 持久化维护控制 —— 在真实数据库上完整走一遍准入/排空/恢复的全过程。
 *
 * 此处逐条固定，因为其中任何一条回归都会无声地破坏部署：
 *  - 切换迁移在全新安装上植入 `open`、在遗留数据库上植入 `draining`，
 *    并在任何 DDL 运行之前拒绝不安全的遗留切换
 *    （进行中的对局、存活的预约、未落定的战绩、存活的旧运行时租约），且无论哪种情况都保留用户数据；
 *  - `enterMaintenance`/`leaveMaintenance` 是基于 revision 的 CAS，
 *    会拒绝陈旧与重复操作，而不是静默接管；
 *  - 恢复（`leaveMaintenance`）要求租约存活，且调用方需证明其观察到的是哪一代运行时 ——
 *    陈旧的运维方不得在继任者之下重新打开维护；
 *  - 排空期间准入故障闭锁，且排空屏障恰好只统计必须完成的工作
 *    （进行中的对局、存活的预约、等待中的票据、未落定的战绩），
 *    忽略空闲大厅；而运行时状态未知时 `ready` 保持 false。
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
// 这里的每个测试都会启动一个真实的 WASM Postgres；测试运行器默认的 5 秒并不够。
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

/** 一个全新、迁移完整的内存数据库 —— 「新安装」形态。 */
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

/** 假装某个运行时此刻持有租约（代际就是该行上的普通整数）。 */
async function holdLease(db: Database, epoch: number, leaseInMs = 60_000): Promise<void> {
  await db.update(runtimeControl).set({
    runtime_id: `runtime-${epoch}`,
    runtime_epoch: epoch,
    lease_until: Date.now() + leaseInMs,
  });
}

/**
 * 一个临时迁移目录，仅包含那份不可变的基线，
 * 使测试可以迁移到遗留的按版本发布的 schema、植入数据，
 * 然后在其之上运行真实的 0001 切换迁移。
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

/** 0000 schema 上的一条遗留发布期房间记录。 */
function legacyRoomSql(id: string, extraColumns = '', extraValues = ''): string {
  return [
    `insert into rooms (id, release_id, host_id, mode, theme, difficulty, phase, created_at, updated_at${extraColumns ? `, ${extraColumns}` : ''})`,
    `values ('${id}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'host', 'quick', 'autumn', 'hard', 'lobby', 1700000000000, 1700000000000${extraValues});`,
  ].join(' ');
}

/**
 * 各遗留夹具共享一个账号与一个活跃的发布版本；
 * 每个场景都会在旧的 schema 上添加自己的行
 * （原生 SQL —— 当前 schema 中已不存在发布期的那些表）。
 */
function legacySeed(blockers: string): string {
  return [
    `insert into accounts (id, username, wechat_identity, created_at) values ('legacy-user', '旧用户', 'union:legacy-user', ${NOW});`,
    `insert into release_versions (id, state, artifact_digest, operation_id, created_at, updated_at) values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'active', 'digest', 'op', ${NOW}, ${NOW});`,
    blockers,
  ].join('\n');
}

/**
 * 一个遗留发布期数据库：只迁移到 0000，然后植入数据。
 * 真实的切换迁移（仓库的 drizzle 目录）由调用方施加 ——
 * 成功即断言新状态，被拒绝即断言守卫生效。
 */
async function openLegacyDb(seedSql: string): Promise<{
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
}> {
  // 不传参数：一个真正用后即弃的进程内实例。（传入 ':memory:' 字符串会被
  // 当作持久化的数据目录 —— 产品代码中是把这种写法映射到此处同样的无参构造，
  // 靠的是 URL 解析器的 `pglite-memory` 驱动。）
  const client = new PGlite();
  const db = drizzleForPglite(client, { schema });
  await migratePglite(db, { migrationsFolder: await stageLegacyMigrationsFolder() });
  await client.exec(seedSql);
  return { client, db };
}

/** 针对遗留数据库运行真实切换迁移，并返回失败（若有）。 */
function runCutover(db: PgliteDatabase<typeof schema>): Promise<Error | null> {
  return migratePglite(db, { migrationsFolder: DRIZZLE_DIR }).then(
    () => null,
    (error: unknown) => error as Error,
  );
}

describe('切换迁移的初始化与守卫', () => {
  it('全新空安装初始化为 open 状态，供开发使用', async () => {
    const db = await freshDb();
    const info = await readMaintenance(db);
    expect(info).toEqual({ mode: 'open', revision: 0, updatedAt: expect.any(Number) });
  });

  it('遗留切换初始化为 draining，保留用户数据并提升指定管理员', async () => {
    const { client, db } = await openLegacyDb(
      legacySeed(
        legacyRoomSql('a00000000000000000000007', 'persistence', ", 'saved'") +
          ` update rooms set phase = 'finished' where id = 'a00000000000000000000007';` +
          // 运维人员指定的管理身份 —— 管理权是一种微信会话角色，
          // 因此切换迁移本身必须把这个既有账号恰好提升一次。
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
    // 角色分配：被指定的身份成为 admin，其他所有账号保持 user。
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
    it(`在存在 ${name} 时拒绝遗留切换，且不触碰任何内容`, async () => {
      const { client, db } = await openLegacyDb(seed);
      const failure = await runCutover(db);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain('迁移中止');
      expect(failure?.message).toContain(phrase);
      // 拒绝就是拒绝：遗留 schema 与每一行都与之前完全一致。
      const intact = await client.query<{ versions: number; rooms: number; users: number }>(
        'select (select count(*) from release_versions) as versions, (select count(*) from rooms) as rooms, (select count(*) from accounts) as users',
      );
      expect(intact.rows[0]).toEqual({ versions: 1, rooms, users: 1 });
      await client.close();
    });
  }
});

describe('数据库打开的迁移层级策略', () => {
  /** 一个用后即弃的 PGlite 文件目录 —— 必需，因为 `migrate: false` 会重新打开它。 */
  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-policy-'));
    cleanupPaths.push(dir);
    return dir;
  }

  /**
   * 由随构建交付的目录派生而来的目录：`ahead` 追加一个未来的迁移；
   * `diverged` 改写最新的文件（SQL 语义相同，哈希不同）。
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

  it('接受前缀完全匹配的领先数据库 —— 回滚仍然可行', async () => {
    const dataDir = await tempDataDir();
    const url = `pglite://${dataDir}`;
    const ahead = await openDatabase(url, {
      migrationsFolder: await stageDerivedMigrationsFolder('ahead'),
    });
    await ahead.close();

    // 较旧的镜像（本次构建）打开较新的 schema：它所认识的前缀匹配，
    // 因此兼容回滚必须成功 —— 这里不存在向下迁移。
    for (const migrate of [false, true]) {
      const rolledBack = await openDatabase(url, { migrate });
      try {
        expect(await readMaintenance(rolledBack.db)).toMatchObject({ mode: 'open' });
      } finally {
        await rolledBack.close();
      }
    }
  });

  it('只读模式下拒绝缺失的迁移，默认模式下则自动升级', async () => {
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

  it('拒绝预期迁移哈希发生分歧的打开操作', async () => {
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

describe('enterMaintenance 与 leaveMaintenance 的 revision CAS', () => {
  it('进入 draining、递增 revision，并恰好删除一次等待中的票据', async () => {
    const db = await freshDb();
    await insertAccount(db, 'queue-user');
    await insertWaitingTicket(db, 'queue-user');

    const info = await enterMaintenance(db, 0);
    expect(info).toEqual({ mode: 'draining', revision: 1, updatedAt: expect.any(Number) });
    expect(await db.select().from(matchTickets)).toEqual([]);

    // 即便使用当前最新的 revision，重复操作也会被拒绝 —— 没有任何人会重复进入。
    const repeat = await enterMaintenance(db, info.revision).then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeat).toBeInstanceOf(MaintenanceConflict);
    expect(await readMaintenance(db)).toMatchObject({ mode: 'draining', revision: 1 });
  });

  it('拒绝陈旧的 revision，且不做任何改动', async () => {
    const db = await freshDb();
    const stale = await enterMaintenance(db, 7).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(MaintenanceConflict);
    expect(await readMaintenance(db)).toMatchObject({ mode: 'open', revision: 0 });
  });

  it('仅对持有存活租约、且与观测代际一致的运行时予以恢复', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);
    await holdLease(db, 3);

    // 顺利的恢复恰好引用运维人员所观察到的 revision 与运行时代际。
    const resumed = await leaveMaintenance(db, drained.revision, 3);
    expect(resumed).toEqual({ mode: 'open', revision: 2, updatedAt: expect.any(Number) });

    // 重复恢复（已经处于 open）会像任何陈旧操作一样被拒绝。
    const repeat = await leaveMaintenance(db, resumed.revision, 3).then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeat).toBeInstanceOf(MaintenanceConflict);
  });

  it('在无租约、租约失效或面对继任者代际时拒绝恢复', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);

    // 从未有运行时占用过该租约：没有任何主体能为服务器健康作证。故障闭锁。
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

    // 存活的租约由与运维人员所观察到的不同的代际持有：
    // 陈旧的运维方不得在其从未检视过的继任者之下重新打开维护。
    await holdLease(db, 4);
    const successor = await leaveMaintenance(db, drained.revision, 2).then(
      () => null,
      (error: unknown) => error,
    );
    expect(successor).toBeInstanceOf(MaintenanceConflict);
    expect((successor as Error).message).toContain('第 4 代');
    expect(await readMaintenance(db)).toMatchObject({ mode: 'draining', revision: 1 });
  });

  it('面对陈旧 revision 时拒绝恢复', async () => {
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

describe('持久化准入', () => {
  it('open 期间予以准入，并在准入事务内提交回调', async () => {
    const db = await freshDb();
    const result = await withAdmission(db, async (tx) => {
      const info = await readMaintenance(tx);
      return { mode: info.mode, controlRows: (await tx.select().from(runtimeControl)).length };
    });
    expect(result.mode).toBe('open');
    expect(result.controlRows).toBe(1);
  });

  it('进入 draining 后以 maintenance:draining 故障闭锁', async () => {
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

describe('排空屏障检查', () => {
  it('恰好统计阻塞性工作，并忽略空闲大厅', async () => {
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
    // 进入维护会删除等待中的票据；迟到的到达者会像其他票据一样被统计。
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

    // 过期的预约无需任何人清理便会自动停止阻塞。
    await db
      .update(rooms)
      .set({ reservation_expires_at: Date.now() - 1_000 })
      .where(eq(rooms.id, 'a00000000000000000000004'));
    const afterExpiry = await inspectMaintenance(db);
    expect(afterExpiry.liveReservations).toBe(0);
  });

  it('仅当排空完成、无阻塞且运行时状态已知时才报告就绪', async () => {
    const db = await freshDb();
    const drained = await enterMaintenance(db, 0);
    expect((await inspectMaintenance(db)).ready).toBe(true);

    // 未知的运行时状态（租约失效且未优雅释放）即便在零工作量下也会阻塞就绪，
    // 并给出恢复证明必须引用的代际。
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

    // open 模式永远不就绪 —— 就绪是排空判定。
    await leaveMaintenance(db, drained.revision, 6);
    expect((await inspectMaintenance(db)).ready).toBe(false);
  });
});
