/**
 * 真实 PGlite 文件数据库上的打开/关闭生命周期 —— 归属权与就绪状态所在之处。
 *
 * 此处固定的是第二个进程（或同一进程内的第二次打开）可能演变为
 * 数据损坏或静默数据分叉的失败模式：
 * 打开操作会在数据库可用之前先应用仓库的迁移；
 * 已被占用的数据目录在第一个占用者存活期间会拒绝每一个后来者；
 * 同一个真实目录的符号链接别名会收敛到单一的占用声明；
 * 崩溃残留的锁文件会带着已记录的回执拒绝下一个打开者，而不是被窃取；
 * 迁移失败会把目录交还，使修正后的重试可以占用它；
 * 且干净关闭是唯一能释放占用声明的行为。
 * 内存数据库只在 URL 明确要求 `:memory:` 时存在，且每次都从空开始。
 * 默认迁移目录全程都会被走到 —— 测试从仓库根目录运行，与开发服务器完全一致。
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  DatabaseMigrationError,
  DirectoryLockError,
  accounts,
  openDatabase,
  type OpenedDatabase,
} from '../../server/db';
import { readServerConfig } from '../../server/config';
import { startServer } from '../../server/start';

const NOW = 1_700_000_000_000;
const TIMEOUT = 120_000;
// 这里的每个测试都会启动一个真实的 WASM Postgres；测试运行器默认的 5 秒并不够。
setDefaultTimeout(TIMEOUT);

const cleanupPaths: string[] = [];
const opened: OpenedDatabase[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {});
  }
  await Promise.all(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  );
});

/** 一个用后即弃的 PGlite 数据目录及其同级锁文件，两者都会在清理时删除。 */
async function tempDataDir(): Promise<{ dir: string; url: string; lockPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-'));
  const lockPath = path.join(path.dirname(dir), `${path.basename(dir)}.spelltype-db.lock`);
  cleanupPaths.push(dir, lockPath);
  return { dir, url: `pglite://${dir}`, lockPath };
}

async function insertAccount(db: OpenedDatabase['db'], id: string): Promise<void> {
  await db.insert(accounts).values({
    id,
    username: `user-${id}`,
    wechat_identity: `open:${id}`,
    created_at: NOW,
  });
}

describe('基于 PGlite 文件目录的 openDatabase', () => {
  it('使用前先迁移，关闭后数据保留，重新打开具备幂等性', async () => {
    const { url } = await tempDataDir();
    const first = await openDatabase(url);
    opened.push(first);
    await insertAccount(first.db, 'account-1');
    await first.close();

    // 第二次打开会在一个已迁移的数据库上再次运行同一批迁移；
    // 日志必须使其成为空操作，而不是重复 DDL 失败。
    const second = await openDatabase(url);
    opened.push(second);
    const rows = await second.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(NOW);
    expect(typeof rows[0]?.created_at).toBe('number');
    await second.close();
  });

  it('在生产配置下自动迁移空数据库，并能安全重启', async () => {
    const { url } = await tempDataDir();
    const config = await readServerConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://127.0.0.1/spelltype',
      PUBLIC_ORIGIN: 'https://spelltype.example',
      WECHAT_BRIDGE_BASE_URL: 'https://bridge.example',
      WECHAT_BRIDGE_APP_ID: 'startup-test',
      WECHAT_BRIDGE_APP_KEY: 'startup-test-app-key',
      HOST: '127.0.0.1',
      PORT: '0',
    });
    // 走一遍生产配置，只替换为隔离的数据库，并去掉已构建的静态资源。
    config.databaseUrl = url;
    config.assetsRoot = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = await startServer({ config });
      try {
        const response = await fetch(`${server.url}/health`);
        expect(response.status).toBe(200);
      } finally {
        await server.close();
      }
    }
    const database = await openDatabase(url, { migrate: false });
    opened.push(database);
    await insertAccount(database.db, 'production-startup');
    expect((await database.db.select().from(accounts))[0]?.id).toBe('production-startup');
  });

  it('在第一个所有者关闭前拒绝第二个所有者，随后交出目录', async () => {
    const { url } = await tempDataDir();
    const first = await openDatabase(url);
    opened.push(first);

    let failure: unknown;
    try {
      await openDatabase(url);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    expect((failure as Error).message).toContain('already claimed');
    expect((failure as Error).message).toContain(`pid ${process.pid}`);
    expect((failure as Error).message).toContain('never steals');

    await first.close();
    const reopened = await openDatabase(url);
    opened.push(reopened);
    expect(await reopened.db.select().from(accounts)).toEqual([]);
    await reopened.close();
  });

  it('把符号链接别名收敛到单一占用声明，使一个真实目录无法出现两个所有者', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-real-'));
    const alias = `${real}-alias`;
    await symlink(real, alias);
    cleanupPaths.push(real, alias);

    // 通过别名打开会占用规范化之后的目录；因此以真实名称访问同一个目录时
    // 必须被拒绝，而不是被授予第二条字面路径的锁。
    const first = await openDatabase(`pglite://${alias}`);
    opened.push(first);

    let failure: unknown;
    try {
      await openDatabase(`pglite://${real}`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    expect((failure as Error).message).toContain(`pid ${process.pid}`);

    await first.close();
    // 一旦（唯一的）占用声明被释放，该目录在任何名称下都恢复空闲。
    const second = await openDatabase(`pglite://${real}`);
    opened.push(second);
    await second.close();
  });

  it('面对崩溃残留的锁故障闭锁，绝不自动接管', async () => {
    const { dir, url, lockPath } = await tempDataDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2 ** 28, hostname: 'crashed-host', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    );

    let failure: unknown;
    try {
      await openDatabase(url);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    const message = (failure as Error).message;
    expect(message).toContain('pid 268435456');
    expect(message).toContain('no longer running');
    // 拒绝信息所给出的锁文件路径与占用者推导的一致：规范化（realpath）形式。
    const canonicalDir = await realpath(dir);
    const canonicalLock = path.join(
      path.dirname(canonicalDir),
      `${path.basename(canonicalDir)}.spelltype-db.lock`,
    );
    expect(message).toContain(canonicalLock);
    expect(message).toContain('never steals');
    // 拒绝之后占用声明保持原样：做决定的是运维人员，而不是这段代码。
    await rm(canonicalLock);
  });

  it('迁移失败时释放占用声明，使修正后的重试可以占用该目录', async () => {
    const { url } = await tempDataDir();
    const broken = await mkdtemp(path.join(tmpdir(), 'spelltype-migrations-'));
    cleanupPaths.push(broken);
    await mkdir(path.join(broken, 'meta'), { recursive: true });
    await writeFile(
      path.join(broken, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '0', when: 1, tag: '0000_broken', breakpoints: true }],
      }),
    );
    await writeFile(path.join(broken, '0000_broken.sql'), 'CREATE TABLE definitely_broken(;');

    const failure = await openDatabase(url, { migrationsFolder: broken }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // 尽管失败，占用声明仍被释放：现在用真实迁移打开可以成功。
    const retry = await openDatabase(url);
    opened.push(retry);
    expect(await retry.db.select().from(accounts)).toEqual([]);
    await retry.close();
  });
});

describe('openDatabase 内存模式', () => {
  it('仅当 URL 明确要求 :memory: 时才打开用后即弃的数据库', async () => {
    const first = await openDatabase('pglite://:memory:');
    opened.push(first);
    await insertAccount(first.db, 'memory-1');
    await first.close();

    const second = await openDatabase('pglite://:memory:');
    opened.push(second);
    expect(await second.db.select().from(accounts)).toEqual([]);
    await second.close();
  });
});

describe('openDatabase 故障闭锁防护', () => {
  it('在打开任何驱动之前拒绝不存在的迁移目录', async () => {
    const missing = path.join(tmpdir(), 'definitely-missing-drizzle-folder');
    // 目录检查优先于网络 IO，对 PostgreSQL 也是如此。
    for (const url of ['pglite://:memory:', 'postgres://127.0.0.1:1/spelltype']) {
      const failure = await openDatabase(url, { migrationsFolder: missing }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DatabaseMigrationError);
    }
  });
});
