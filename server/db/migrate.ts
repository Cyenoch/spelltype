import type { SQL } from 'bun';
import { drizzle as drizzleForBunSql } from 'drizzle-orm/bun-sql';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { migrate as migrateBunSql } from 'drizzle-orm/bun-sql/migrator';
import { schema } from './schema';

/**
 * PostgreSQL 数据库迁移。
 *
 * 与 PGlite 不同（后者的单所有者目录锁已经自动将所有写入者串行化），PostgreSQL
 * 服务器允许接入多个并发的游戏/API 进程。由于它们全部运行相同的 `openDatabase` 流程，
 * 数据库迁移必须构造成跨进程的临界区：调用方传入一个专属保留的 Bun.SQL 连接（绝不能是连接池客户端，
 * 后者的执行语句可能落到任意会话上并继承迁移超时），本模块设置有界的会话级超时，并在该连接上获取确定的
 * 咨询锁（advisory lock），随后 Drizzle 迁移器通过绑定到这同一个保留连接的 Drizzle 实例执行。
 * 获取锁的过程采用对 `pg_try_advisory_lock` 的有界轮询，因此即便持有者卡死，也只会按已知的时间上限延迟启动，
 * 而不会因 `pg_advisory_lock` 无限期阻塞。
 */

export class DatabaseMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseMigrationError';
  }
}

/**
 * 咨询锁所需的唯一查询接口。Bun SQL 连接的 `unsafe(text, params)`
 * 在结构上即可满足要求；测试中可注入桩实现。
 */
export type AdvisoryLockQuery = (text: string, params: unknown[]) => PromiseLike<unknown[]>;

/**
 * `'spelltype:drizzle-migrations'` 的 FNV-1a 64 位哈希，并映射到 PostgreSQL `bigint` 的有符号范围内。
 * 该值在本应用的所有部署中保持稳定；同一数据库中的其他应用绝不会与其偶然冲突。
 */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0x7fffffffffffffffn;
  }
  return hash;
}

export const MIGRATION_ADVISORY_LOCK_KEY = fnv1a64('spelltype:drizzle-migrations');

/** 迁移会话内会话级等待的硬性上限。 */
export const MIGRATION_LOCK_TIMEOUT_SQL = "set lock_timeout = '10s'";
export const MIGRATION_STATEMENT_TIMEOUT_SQL = "set statement_timeout = '60s'";

/** 默认将锁等待限制在 10 秒，DDL 语句限制在 60 秒。 */

export interface MigrationLockOptions {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdvisoryMigrationLock {
  /**
   * 在同一会话上释放锁并向外抛出查询失败：在锁清理操作未经证实前，`openDatabase` 绝不能声称数据库处于健康状态。
   * （随后关闭迁移连接池若连接断开也会释放锁——但该结果必须被明确暴露，而非假定成立。）
   */
  release(): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 在调用方的会话上获取迁移咨询锁。获取被拒绝时会携带咨询键名，以便运维人员通过 `pg_locks` 排查占用会话。
 */
export async function acquireAdvisoryMigrationLock(
  query: AdvisoryLockQuery,
  options: MigrationLockOptions = {},
): Promise<AdvisoryMigrationLock> {
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const key = MIGRATION_ADVISORY_LOCK_KEY.toString();

  const deadline = now() + waitMs;
  for (;;) {
    const rows = await query('select pg_try_advisory_lock($1) as locked', [key]);
    if ((rows[0] as { locked?: unknown } | undefined)?.locked === true) {
      return {
        async release(): Promise<void> {
          await query('select pg_advisory_unlock($1)', [key]);
        },
      };
    }
    if (now() >= deadline) {
      throw new DatabaseMigrationError(
        `Another session holds the migration advisory lock (key ${key}); waited ${waitMs} ms. ` +
          'Inspect pg_locks/pg_stat_activity for the holder before retrying.',
      );
    }
    await sleep(pollMs);
  }
}

/**
 * 在给定的独立会话上执行 Drizzle 迁移。调用方管理连接的生命周期，且在调用前必须已经在该会话上持有咨询锁。
 */
export async function migratePostgresOn(
  session: SQL,
  migrationsFolder: string,
): Promise<BunSQLDatabase<typeof schema>> {
  const db = drizzleForBunSql(session, { schema });
  await migrateBunSql(db, { migrationsFolder });
  return db;
}
