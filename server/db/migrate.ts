import type { SQL } from 'bun';
import { drizzle as drizzleForBunSql } from 'drizzle-orm/bun-sql';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { migrate as migrateBunSql } from 'drizzle-orm/bun-sql/migrator';
import { schema } from './schema';

/**
 * PostgreSQL migrations.
 *
 * Unlike PGlite — whose single-owner directory lock already serializes every writer — a PostgreSQL
 * server accepts many concurrent game/API processes. All of them run the same `openDatabase` flow,
 * so migration must be a cross-process critical section: the caller hands over one reserved
 * Bun.SQL connection (never a pooled client, whose statements would land on arbitrary sessions and
 * inherit the migration timeouts), this module sets bounded session timeouts, takes a deterministic
 * advisory lock on that same session, and the drizzle migrator runs through a drizzle instance
 * bound to the very same reserved connection. Waiting for the lock is a bounded poll of
 * `pg_try_advisory_lock`, so a wedged holder delays startup by a known ceiling instead of blocking
 * forever on `pg_advisory_lock`.
 */

export class DatabaseMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseMigrationError';
  }
}

/**
 * The one query surface the advisory lock needs. A Bun SQL connection's `unsafe(text, params)`
 * satisfies it structurally; tests inject a stub.
 */
export type AdvisoryLockQuery = (text: string, params: unknown[]) => PromiseLike<unknown[]>;

/**
 * FNV-1a 64 of `'spelltype:drizzle-migrations'`, masked into the signed range of PostgreSQL
 * `bigint`. The value is stable across every deployment of this app; no other application using
 * the same database could collide with it by accident.
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

/** Hard ceiling on session-level waits inside the migration session. */
export const MIGRATION_LOCK_TIMEOUT_SQL = "set lock_timeout = '10s'";
export const MIGRATION_STATEMENT_TIMEOUT_SQL = "set statement_timeout = '60s'";

/** Defaults bound the lock wait to 10s and the DDL statements to 60s. */
export interface MigrationLockOptions {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdvisoryMigrationLock {
  /**
   * Unlocks on the same session and propagates query failures: openDatabase must never report a
   * healthy database while the lock cleanup is unproven. (Ending the migration pool afterwards
   * would release the lock if the connection dies — but that outcome is surfaced, not assumed.)
   */
  release(): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Acquires the advisory migration lock on the caller's session. Rejections carry the advisory key
 * so an operator can find the holding session with `pg_locks`.
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
 * Applies the drizzle migrations on the given dedicated session. The caller owns the connection
 * lifecycle and must hold the advisory lock on that same session before calling.
 */
export async function migratePostgresOn(
  session: SQL,
  migrationsFolder: string,
): Promise<BunSQLDatabase<typeof schema>> {
  const db = drizzleForBunSql(session, { schema });
  await migrateBunSql(db, { migrationsFolder });
  return db;
}
