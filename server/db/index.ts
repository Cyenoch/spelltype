import { existsSync } from 'node:fs';
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
 * The native database union. Development runs PGlite; production runs PostgreSQL over Bun's native
 * SQL client. Storage functions accept this union or the corresponding transaction union below.
 */
export type Database = BunSQLDatabase<typeof schema> | PgliteDatabase<typeof schema>;

type BunSqlTx = BunSQLTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
type PgliteTx = PgTransaction<
  PgliteQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** The `db.transaction(async (tx) => ...)` callback parameter, per driver. */
export type Transaction = BunSqlTx | PgliteTx;

/** Anything that can run queries: an open database or a transaction from either driver. */
export type QueryDatabase = Database | Transaction;

/**
 * An open-phase failure that is not about the URL, the lock or migrations themselves — e.g. an
 * engine that refused to shut down after a failed open. The original failure rides in `cause`.
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
   * Closes the driver and, for PGlite, releases the exclusive data-directory claim. A clean close
   * releases the directory; a failed close intentionally leaves the claim in place so no second
   * owner can open a database of uncertain state.
   */
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /**
   * Defaults to the repository's `drizzle/` folder, resolved relative to this module (correct for
   * the unbundled dev server and tests). Bundled deployments must pass the folder they ship.
   */
  migrationsFolder?: string;
}

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * Opens the database, applies migrations, and only then resolves — callers may start listening as
 * soon as this resolves. Both drivers run the same generated migration set, and both paths fail
 * closed: a malformed URL, a contested PGlite directory or a failed migration never resolves into
 * a half-ready database.
 */
export async function openDatabase(
  rawUrl: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenedDatabase> {
  const parsed = parseDatabaseUrl(rawUrl);
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  if (!existsSync(migrationsFolder)) {
    throw new DatabaseMigrationError(
      `Drizzle migrations folder not found at ${migrationsFolder}; pass options.migrationsFolder explicitly.`,
    );
  }
  if (parsed.driver === 'postgres') {
    return openPostgres(parsed.connectionString, migrationsFolder);
  }
  return openPglite(parsed, migrationsFolder);
}

/**
 * PostgreSQL: a dedicated single-connection migration pool owns the whole migration. The bounded
 * session SETs, the advisory lock and the drizzle migrator all run on that one reserved session;
 * because `release()` only returns a session to its pool, the migration pool is then *ended* —
 * the SETs and the lock provably die with it instead of surviving on a pooled session. Only after
 * a clean end does the application open its own separate pool.
 */
async function openPostgres(
  connectionString: string,
  migrationsFolder: string,
): Promise<OpenedDatabase> {
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
        // Propagates: a migration whose unlock could not be proven is not a clean migration.
        if (lock !== undefined) await lock.release();
      } finally {
        // Return the session even if the unlock failed; the pool end below still runs.
        reserved.release();
      }
    }
  } catch (error) {
    try {
      await migrationSql.end();
    } catch {
      // Preserve the real failure; the lock dies when the process's connection does regardless.
    }
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError('PostgreSQL migration did not complete cleanly.', {
      cause: error,
    });
  }
  // Migration proven complete and unlocked: end the migration pool. A failure here still fails
  // the open — the lock proof must not rest on a session we could not close.
  try {
    await migrationSql.end();
  } catch (error) {
    throw new DatabaseMigrationError(
      'The PostgreSQL migration pool could not be closed after a clean migration.',
      { cause: error },
    );
  }

  const appSql = new SQL(connectionString);
  return {
    db: drizzleForBunSql(appSql, { schema }),
    close: () => appSql.end(),
  };
}

/**
 * PGlite: claim the data directory before the WASM instance exists (PGlite is handed exactly the
 * canonical claimed directory, so lock and use can never diverge), then migrate on the same
 * single-connection instance the app will use. The claim is what serializes migrations here —
 * only one process can hold the directory at all.
 */
async function openPglite(
  parsed: Extract<ParsedDatabaseUrl, { driver: 'pglite' | 'pglite-memory' }>,
  migrationsFolder: string,
): Promise<OpenedDatabase> {
  const claim = parsed.driver === 'pglite' ? await claimDataDirectory(parsed.dataDir) : null;
  let client: PGlite | null = null;
  try {
    client = new PGlite(claim?.directory);
    const db = drizzleForPglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
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
        // Shutdown failed: the engine may still hold the directory's files, so the claim stays —
        // handing it back now would let a second opener in. Surface the shutdown failure without
        // losing the original cause.
        throw new DatabaseOpenError(
          `PGlite failed to shut down after a failed open (${String(closeError)}); ` +
            'the directory claim was kept so no second opener can start.',
          { cause: error },
        );
      }
    }
    // The engine is provably down (or never started): the directory can be handed back so the
    // next attempt — after whatever fix — can claim it.
    try {
      await claim?.release();
    } catch {
      // The lock file stays; the next open fails closed with the recorded receipt.
    }
    throw error;
  }
}
