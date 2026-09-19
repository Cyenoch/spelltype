import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { SQL } from 'bun';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle as drizzleForBunSql } from 'drizzle-orm/bun-sql';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import type { BunSQLTransaction } from 'drizzle-orm/bun-sql/session';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle as drizzleForPglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase, PgliteQueryResultHKT } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { claimDataDirectory } from './lock';
import {
  acquireAdvisoryMigrationLock,
  DatabaseMigrationError,
  MIGRATION_LOCK_TIMEOUT_SQL,
  MIGRATION_STATEMENT_TIMEOUT_SQL,
  migratePostgresOn,
  type AdvisoryMigrationLock,
} from './migrate';
import { schema } from './schema';
import { parseDatabaseUrl, type ParsedDatabaseUrl } from './url';

export { parseDatabaseUrl, DatabaseUrlError, type ParsedDatabaseUrl } from './url';
export { claimDataDirectory, DirectoryLockError, type DirectoryClaim } from './lock';
export {
  acquireAdvisoryMigrationLock,
  DatabaseMigrationError,
  MIGRATION_ADVISORY_LOCK_KEY,
  migratePostgresOn,
  type AdvisoryLockQuery,
  type AdvisoryMigrationLock,
} from './migrate';
export * from './schema';

/**
 * 原生数据库联合类型。开发环境使用 PGlite；
 * 生产环境通过 Bun 原生 SQL 客户端连接 PostgreSQL。
 * 存储层函数接受此联合类型，或下方对应的事务联合类型。
 */
export type Database = BunSQLDatabase<typeof schema> | PgliteDatabase<typeof schema>;

type BunSqlTx = BunSQLTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
type PgliteTx = PgTransaction<
  PgliteQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** 各驱动对应的 `db.transaction(async (tx) => ...)` 回调参数类型。 */
export type Transaction = BunSqlTx | PgliteTx;

/** 任何具备查询能力的对象：已打开的数据库实例，或由任一驱动发起的事务。 */
export type QueryDatabase = Database | Transaction;

/**
 * 打开阶段的失败，且与 URL、锁或迁移本身无关 ——
 * 例如引擎在一次失败的打开之后拒绝关闭。原始失败挂在 `cause` 上。
 */
export class DatabaseOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseOpenError';
  }
}

export interface OpenedDatabase {
  db: Database;
  /**
   * 关闭驱动；对于 PGlite，还会释放其排他的数据目录占用声明。正常关闭会释放目录；
   * 失败的关闭会刻意保留占用声明，使第二个所有者无法打开一个状态未决的数据库。
   */
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /**
   * 默认为仓库的 `drizzle/` 目录，相对本模块解析
   * （对未打包的开发服务器与测试而言是正确的）。
   * 打包部署必须传入它们所交付的那个目录。
   */
  migrationsFolder?: string;
  /**
   * 打开时应用待处理迁移（默认 `true`，生产启动亦然）。
   * 维护命令传入 `false`，以便在不改动 schema 的前提下检查它。
   * 两种模式都会校验随构建交付的迁移前缀，并在历史陈旧或分歧时故障闭锁。
   */
  migrate?: boolean;
}

export interface MigrateDatabaseOptions {
  /**
   * 默认为仓库的 `drizzle/` 目录（见 {@link OpenDatabaseOptions}）。
   * 只有该目录可配置：迁移过程绝不打开应用连接池，也绝不占用运行时归属租约 ——
   * 迁移入口始终是一个纯粹的 schema 工具。
   */
  migrationsFolder?: string;
}

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * 本次构建所交付的所有迁移文件的 sha256，按日志顺序排列。
 * 迁移器会把相同的哈希记录在 `drizzle.__drizzle_migrations` 中，
 * 因此通过逐项精确比对即可判定某次打开是否包含本次构建所要求的完整迁移前缀。
 */
function shippedMigrationHashes(migrationsFolder: string): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.map((entry) =>
    createHash('sha256')
      .update(readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`)))
      .digest('hex'),
  );
}

/**
 * 给定会话上已应用的迁移哈希，按应用顺序排列。两种驱动都将其保存在
 * `drizzle.__drizzle_migrations(id, hash, created_at)` 中；只有查询接口不同。
 */
async function appliedMigrationHashesPostgres(client: SQL): Promise<string[]> {
  const rows = (await client.unsafe(
    'select hash from drizzle.__drizzle_migrations order by id',
  )) as Array<{ hash: string }>;
  return rows.map((row) => row.hash);
}

async function appliedMigrationHashesPglite(client: PGlite): Promise<string[]> {
  const result = await client.query<{ hash: string }>(
    'select hash from drizzle.__drizzle_migrations order by id',
  );
  return result.rows.map((row) => row.hash);
}

/**
 * 故障闭锁的前缀比对：本次构建交付的每一个迁移都必须以其确切的哈希
 * 出现在数据库的已应用历史中。领先于本次构建的数据库（更旧的镜像之上
 * 被更新镜像应用了额外、更新的迁移）会被刻意接受 ——
 * 回滚到兼容的旧镜像必须始终可行，而这里不存在向下迁移。
 * 会拒绝打开的情形：数据库缺少本次构建所要求的某个迁移，
 * 或某个预期迁移的记录哈希已不再匹配本次构建的文件（历史被改写）。
 */
function assertMigrationLevelMatches(applied: string[], shipped: string[]): void {
  if (applied.length < shipped.length) {
    throw new DatabaseMigrationError(
      `The database is missing migrations this build requires: ${applied.length} of ` +
        `${shipped.length} applied. Apply pending migrations before opening with migrate: false.`,
    );
  }
  for (let i = 0; i < shipped.length; i += 1) {
    if (applied[i] !== shipped[i]) {
      throw new DatabaseMigrationError(
        `The database's migration history diverges from this build at entry ${i}. The migration ` +
          'journal is append-only; investigate before starting the application.',
      );
    }
  }
}

/**
 * 打开数据库，且仅在其完全可用时才解析完成：默认先应用待处理迁移，
 * 随后校验随构建交付的迁移前缀。两种驱动运行完全相同的生成迁移集，
 * 且两条路径都故障闭锁：格式错误的 URL、存在争用的 PGlite 目录、
 * 失败的迁移或陈旧的 schema，都绝不会解析出一个半就绪的数据库。
 */
export async function openDatabase(
  rawUrl: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenedDatabase> {
  const parsed = parseDatabaseUrl(rawUrl);
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const migrate = options.migrate ?? true;
  if (!existsSync(migrationsFolder)) {
    throw new DatabaseMigrationError(
      `Drizzle migrations folder not found at ${migrationsFolder}; pass options.migrationsFolder explicitly.`,
    );
  }
  if (parsed.driver === 'postgres') {
    return openPostgres(parsed.connectionString, migrationsFolder, migrate);
  }
  return openPglite(parsed, migrationsFolder, migrate);
}

/**
 * PostgreSQL：由专用的单连接迁移池负责整个迁移流程。有界的会话级 SET、
 * 咨询锁以及 drizzle 迁移器全部运行在那唯一一条预留会话上；
 * 由于 `release()` 只是把会话归还给其连接池，迁移池随后会被*结束* ——
 * 那些 SET 与锁可证明地随之消亡，而不是继续存活在某条池化会话上。
 * 只有在干净结束之后，应用才会打开自己独立的连接池。
 */
async function openPostgres(
  connectionString: string,
  migrationsFolder: string,
  migrate: boolean,
): Promise<OpenedDatabase> {
  if (migrate) {
    await runPostgresMigrations(connectionString, migrationsFolder);
  }
  const appSql = new SQL(connectionString);
  try {
    assertMigrationLevelMatches(
      await appliedMigrationHashesPostgres(appSql),
      shippedMigrationHashes(migrationsFolder),
    );
  } catch (error) {
    await appSql.end().catch(() => {});
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError(
      'The migration bookkeeping (drizzle.__drizzle_migrations) is unreadable or missing.',
      { cause: error },
    );
  }
  return {
    db: drizzleForBunSql(appSql, { schema }),
    close: () => appSql.end(),
  };
}

/**
 * 在专用连接池上执行的 PostgreSQL 迁移临界区：有界 SET、咨询锁、
 * 迁移器、已验证的解锁、连接池结束。
 * 由 `openDatabase`（随后会打开自己的应用连接池）与
 * `migrateDatabase`（刻意到此为止）共用。
 */
async function runPostgresMigrations(
  connectionString: string,
  migrationsFolder: string,
): Promise<void> {
  const migrationSql = new SQL({ url: connectionString, max: 1 });
  try {
    const reserved = await migrationSql.reserve();
    let lock: AdvisoryMigrationLock | undefined;
    try {
      await reserved.unsafe(MIGRATION_LOCK_TIMEOUT_SQL);
      await reserved.unsafe(MIGRATION_STATEMENT_TIMEOUT_SQL);
      lock = await acquireAdvisoryMigrationLock((text, params) => reserved.unsafe(text, params));
      await migratePostgresOn(reserved, migrationsFolder);
    } finally {
      try {
        // 向上传播：无法证明已解锁的迁移不算干净的迁移。
        if (lock !== undefined) await lock.release();
      } finally {
        // 即便解锁失败也归还会话；下方的连接池结束仍会执行。
        reserved.release();
      }
    }
  } catch (error) {
    try {
      await migrationSql.end();
    } catch {
      // 保留真实失败；无论如何，进程的连接一消亡，锁也会随之消亡。
    }
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError('PostgreSQL migration did not complete cleanly.', {
      cause: error,
    });
  }
  // 迁移已被证明完成并解锁：结束迁移连接池。
  // 此处的失败仍会让整个操作失败 —— 锁的证明绝不能依赖一条我们无法关闭的会话。
  try {
    await migrationSql.end();
  } catch (error) {
    throw new DatabaseMigrationError(
      'The PostgreSQL migration pool could not be closed after a clean migration.',
      { cause: error },
    );
  }
}

/**
 * PGlite：在 WASM 实例存在之前先占用数据目录
 * （交给 PGlite 的正是那个规范化后的已占用目录，因此锁定与使用绝不会分歧），
 * 随后在应用将要使用的同一单连接实例上执行迁移 —— 或证明迁移层级。
 * 这里的占用声明正是迁移串行化的手段 —— 同一时间只有一个进程能持有该目录。
 */
async function openPglite(
  parsed: Extract<ParsedDatabaseUrl, { driver: 'pglite' | 'pglite-memory' }>,
  migrationsFolder: string,
  migrate: boolean,
): Promise<OpenedDatabase> {
  const claim = parsed.driver === 'pglite' ? await claimDataDirectory(parsed.dataDir) : null;
  let client: PGlite | null = null;
  try {
    client = new PGlite(claim?.directory);
    const db = drizzleForPglite(client, { schema });
    if (migrate) {
      await migratePglite(db, { migrationsFolder });
    }
    assertMigrationLevelMatches(
      await appliedMigrationHashesPglite(client),
      shippedMigrationHashes(migrationsFolder),
    );
    const openedClient = client;
    const openedClaim = claim;
    return {
      db,
      close: async () => {
        await openedClient.close();
        await openedClaim?.release();
      },
    };
  } catch (error) {
    if (client !== null) {
      try {
        await client.close();
      } catch (closeError) {
        // 关闭失败：引擎可能仍持有该目录的文件，因此占用声明保留 ——
        // 此刻交还它会放进第二个打开者。上报该关闭失败，同时不丢失原始原因。
        throw new DatabaseOpenError(
          `PGlite failed to shut down after a failed open (${String(closeError)}); ` +
            'the directory claim was kept so no second opener can start.',
          { cause: error },
        );
      }
    }
    // 引擎已被证明停止（或从未启动）：目录可以交还，
    // 使下一次尝试 —— 在完成相应修复之后 —— 能够占用它。
    try {
      await claim?.release();
    } catch {
      // 锁文件保留；下一次打开会带着已记录的回执故障闭锁。
    }
    throw error;
  }
}

/**
 * 应用待处理迁移然后关闭 —— 别无其他。生产迁移入口用它来推进 schema，
 * 而绝不打开应用数据库、也绝不占用运行时租约，
 * 因此一次迁移运行不可能悄然变成一个正在跑对局的服务进程。
 * 串行化方式与 `openDatabase` 的迁移阶段完全相同：
 * 专用连接池上的 PostgreSQL 咨询锁，或 PGlite 的排他目录占用声明。
 */
export async function migrateDatabase(
  rawUrl: string,
  options: MigrateDatabaseOptions = {},
): Promise<void> {
  const parsed = parseDatabaseUrl(rawUrl);
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  if (!existsSync(migrationsFolder)) {
    throw new DatabaseMigrationError(
      `Drizzle migrations folder not found at ${migrationsFolder}; pass options.migrationsFolder explicitly.`,
    );
  }
  if (parsed.driver === 'postgres') {
    await runPostgresMigrations(parsed.connectionString, migrationsFolder);
    return;
  }
  const claim = parsed.driver === 'pglite' ? await claimDataDirectory(parsed.dataDir) : null;
  let client: PGlite | null = null;
  try {
    client = new PGlite(claim?.directory);
    await migratePglite(drizzleForPglite(client, { schema }), { migrationsFolder });
    await client.close();
    client = null;
    await claim?.release();
  } catch (error) {
    if (client !== null) {
      try {
        await client.close();
      } catch (closeError) {
        throw new DatabaseOpenError(
          `PGlite failed to shut down after a failed migration (${String(closeError)}); ` +
            'the directory claim was kept so no second opener can start.',
          { cause: error },
        );
      }
    }
    try {
      await claim?.release();
    } catch {
      // 锁文件保留；下一次尝试会带着已记录的回执故障闭锁。
    }
    throw error;
  }
}
