/**
 * `node:sqlite` stand-in for the one platform call the Durable Objects' storage layers make.
 *
 * The storage layer declares that surface itself — `SqlStore` in `worker/sql.ts`: a
 * single `exec()` whose cursor exposes `toArray`, `one` and `rowsWritten`. This adapter implements
 * exactly that, so the unit tests exercise the real SQL (the DDL, the column whitelists, the ring
 * trim, the `(match_id, user_id)` idempotency key) against a real SQLite engine without booting
 * workerd, and without casting a fake object to the whole `SqlStorage` interface.
 *
 * Like the platform, `exec()` runs its statement when it is called, the returned cursor iterates
 * the rows it produced, and `one()` fails loudly on an empty result.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlCursor, SqlStore } from '../../worker/sql';

class Cursor<T> implements SqlCursor<T> {
  constructor(
    private readonly rows: T[],
    readonly rowsWritten: number,
  ) {}

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length === 0) throw new Error('one() found no row');
    return this.rows[0];
  }
}

const READ_ONLY_QUERY = /^\s*(?:select|pragma|with)\b/i;

/** The subset of `node:sqlite` bindings that overlaps the platform's `SqlStorageValue`. */
function platformBindings(bindings: SqlStorageValue[]): (string | number | null | Uint8Array)[] {
  return bindings.map((binding) =>
    binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
  );
}

function openTestSql(db: DatabaseSync): SqlStore {
  return {
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlCursor<T> {
      const params = platformBindings(bindings);
      const statement = db.prepare(query);
      if (READ_ONLY_QUERY.test(query)) return new Cursor<T>(statement.all(...params) as T[], 0);
      return new Cursor<T>([], Number(statement.run(...params).changes));
    },
  };
}

export interface TestStorage {
  sql: SqlStore;
  /**
   * The same commit boundary the platform's `transactionSync` gives a Durable Object: every write
   * `callback` makes either commits together or — when it throws — is rolled back and the original
   * error is rethrown. Tests that need transaction semantics wrap the real SQL in this instead of
   * trusting that a column merely exists.
   */
  transactionSync<T>(this: void, callback: () => T): T;
  close(): void;
}

/** An empty in-memory database with no schema: callers run the storage layer's `createSchema()` first. */
export function openTestStorage(): TestStorage {
  const db = new DatabaseSync(':memory:');
  return {
    sql: openTestSql(db),
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The rollback's own failure must not replace the error that caused it.
        }
        throw error;
      }
    },
    close: () => db.close(),
  };
}

/**
 * The same adapter against a real file, for tests that close one instance and reopen the same
 * durable SQLite state through a fresh schema and scope (a room restart without workerd). The
 * file is created on the spot; its parent directory is the caller's business.
 */
export function openFileTestStorage(path: string): TestStorage {
  const db = new DatabaseSync(path);
  return {
    sql: openTestSql(db),
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The rollback's own failure must not replace the error that caused it.
        }
        throw error;
      }
    },
    close: () => db.close(),
  };
}
