/**
 * Direct access to the isolated local D1 SQLite file.
 *
 * The E2E suite owns this file (created under `tests/.state/`), so migrating it and injecting faults
 * (session expiry, a broken `results` table) happens out-of-band here instead of through a public
 * test endpoint in the product. The suite runs under Node, so `node:sqlite` is used directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A spec's bound value as `node:sqlite` takes it: workerd-style buffers become views. */
function bindable(param: unknown): string | number | null | Uint8Array {
  if (
    typeof param === 'string' ||
    typeof param === 'number' ||
    param === null ||
    param instanceof Uint8Array
  )
    return param;
  if (param instanceof ArrayBuffer) return new Uint8Array(param);
  throw new Error(`unsupported sqlite binding: ${Object.prototype.toString.call(param)}`);
}

function bindings(params: unknown[]): (string | number | null | Uint8Array)[] {
  return params.map(bindable);
}

/** Waits out a writer's lock before retrying. */
async function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function findD1Files(persistDir: string): string[] {
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
      else if (entry.name.endsWith('.sqlite') && full.includes(`${path.sep}d1${path.sep}`))
        found.push(full);
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
export function applyMigrations(
  persistDir: string,
  migrationsDir: string,
): { files: string[]; applied: string[] } {
  const files = findD1Files(persistDir);
  const applied: string[] = [];
  for (const file of files) {
    const db = new DatabaseSync(file);
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
      );
      const done = new Set(
        db
          .prepare('SELECT name FROM d1_migrations')
          .all()
          .map((row) => String(row.name)),
      );
      for (const name of migrationFiles(migrationsDir)) {
        if (done.has(name)) continue;
        const sql = fs
          .readFileSync(path.join(migrationsDir, name), 'utf8')
          .replace(/-->\s*statement-breakpoint/g, '');
        db.exec('BEGIN');
        try {
          db.exec(sql);
          db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
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
  run(sql: string, ...params: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  tableExists(table: string): Promise<boolean>;
}

/** Runs a statement against the local D1 file, retrying while workerd holds its write lock. */
export async function runSql(
  db: D1FileHandle,
  sql: string,
  params: unknown[] = [],
  attempts = 10,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.run(sql, ...params);
      return;
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(String((error as Error).message))) throw error;
      await pause(300);
    }
  }
  throw lastError;
}

/** Reads rows, retrying briefly for the same reason as {@link runSql}. */
export async function querySql<T = Record<string, unknown>>(
  db: D1FileHandle,
  sql: string,
  params: unknown[] = [],
  attempts = 10,
): Promise<T[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await db.all<T>(sql, ...params);
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(String((error as Error).message))) throw error;
      await pause(300);
    }
  }
  throw lastError;
}

/** Opens the isolated local D1 file. Each call opens and closes its own connection. */
export function openD1(persistDir: string): D1FileHandle {
  const [file] = findD1Files(persistDir);
  if (!file)
    throw new Error(`no local D1 sqlite file under ${persistDir}; did the application boot?`);

  const handle: D1FileHandle = {
    async run(sql, ...params) {
      const db = new DatabaseSync(file);
      try {
        db.prepare(sql).run(...bindings(params));
      } finally {
        db.close();
      }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const db = new DatabaseSync(file);
      try {
        return db.prepare(sql).all(...bindings(params)) as T[];
      } finally {
        db.close();
      }
    },
    async tableExists(table) {
      return (
        (
          await querySql<{ name: string }>(
            handle,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            [table],
          )
        ).length > 0
      );
    },
  };
  return handle;
}
