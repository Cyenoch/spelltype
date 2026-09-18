/**
 * Direct access to the isolated local D1 SQLite file.
 *
 * The E2E suite owns this file (created under `tests/.state/`), so migrating it and
 * injecting faults (session expiry, a broken `results` table) happens out-of-band here
 * instead of through a public test endpoint in the product.
 *
 * Works under both runtimes the suite may be launched with: `node:sqlite` on Node and
 * `bun:sqlite` on Bun.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SqliteDb {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

/** The subset of `node:sqlite` and `bun:sqlite` this suite relies on. */
interface RawSqlite {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

/** Both runtimes expose statements through `prepare`, so normalise on that. */
function wrapSqlite(raw: RawSqlite): SqliteDb {
  return {
    exec: (sql) => {
      raw.exec(sql);
    },
    run: (sql, ...params) => {
      raw.prepare(sql).run(...params);
    },
    all: <T>(sql: string, ...params: unknown[]) => raw.prepare(sql).all(...params) as T[],
    close: () => raw.close(),
  };
}

export async function openD1File(file: string): Promise<SqliteDb> {
  if (typeof process.versions.bun === 'string') {
    const bunSqlite = 'bun:sqlite';
    const { Database } = (await import(bunSqlite)) as { Database: new (file: string) => RawSqlite };
    return wrapSqlite(new Database(file));
  }
  const { DatabaseSync } = await import('node:sqlite');
  return wrapSqlite(new DatabaseSync(file) as unknown as RawSqlite);
}

export function findD1Files(persistDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sqlite') && full.includes(`${path.sep}d1${path.sep}`)) found.push(full);
    }
  };
  walk(persistDir);
  return found.sort();
}

function migrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Applies pending migration files to every local D1 file, tracking results in the same
 * `d1_migrations` bookkeeping table wrangler uses, so repeated runs are no-ops.
 */
export async function applyMigrations(persistDir: string, migrationsDir: string): Promise<{ files: string[]; applied: string[] }> {
  const files = findD1Files(persistDir);
  const applied: string[] = [];
  for (const file of files) {
    const db = await openD1File(file);
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
      );
      const done = new Set(db.all<{ name: string }>('SELECT name FROM d1_migrations').map((row) => row.name));
      for (const name of migrationFiles(migrationsDir)) {
        if (done.has(name)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8').replace(/-->\s*statement-breakpoint/g, '');
        db.exec('BEGIN');
        try {
          db.exec(sql);
          db.run('INSERT INTO d1_migrations (name) VALUES (?)', name);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw new Error(`migration ${name} failed on ${file}: ${(error as Error).message}`);
        }
        applied.push(`${path.basename(file)}:${name}`);
      }
    } finally {
      db.close();
    }
  }
  return { files, applied };
}

export interface D1FileHandle {
  file: string;
  run(sql: string, ...params: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  tableExists(table: string): Promise<boolean>;
}

/**
 * Runs a statement, retrying while workerd holds a write lock. Fault injection has to
 * land while the application is running, so brief locks are expected.
 */
export async function runSql(db: D1FileHandle, sql: string, params: unknown[] = [], attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.run(sql, ...params);
      return;
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(String((error as Error).message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

/** Reads rows, retrying briefly for the same reason as {@link runSql}. */
export async function querySql<T = Record<string, unknown>>(db: D1FileHandle, sql: string, params: unknown[] = [], attempts = 10): Promise<T[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await db.all<T>(sql, ...params);
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(String((error as Error).message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

/** Opens the isolated local D1 file and retries briefly while workerd holds its write lock. */
export async function openD1(persistDir: string): Promise<D1FileHandle> {
  const [file] = findD1Files(persistDir);
  if (!file) throw new Error(`no local D1 sqlite file under ${persistDir}; did the application boot?`);
  const handle: D1FileHandle = {
    file,
    async run(sql, ...params) {
      const db = await openD1File(file);
      try {
        db.run(sql, ...params);
      } finally {
        db.close();
      }
    },
    async all(sql, ...params) {
      const db = await openD1File(file);
      try {
        return db.all(sql, ...params);
      } finally {
        db.close();
      }
    },
    async tableExists(table) {
      const rows = await handle.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);
      return rows.length > 0;
    },
  };
  return handle;
}
