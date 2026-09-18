/**
 * The slice of the platform's SQL storage the Durable Objects' own databases use.
 *
 * Declaring it once keeps every storage function honest about what it needs — a query runner and the
 * cursor it answers with — and lets `tests/support/sql-storage.ts` drive those functions with a real
 * SQLite engine instead of a `cloudflare:workers` `SqlStorage` double. The platform's own
 * `SqlStorage` satisfies it structurally, so no caller has to convert anything.
 */
export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
}

export interface SqlStore {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlCursor<T>;
}
