import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { schema } from '../../db/schema';

/**
 * The structural base every database handle and transaction handle satisfies —
 * both the PostgreSQL driver and PGlite. Storage helpers take this so a union
 * of the two drivers (and their transactions) can be passed without TypeScript
 * collapsing method signatures at every call; `QueryDatabase` from `server/db`
 * remains the public parameter contract, and every member of it is assignable
 * here.
 */
export type RoomQuery = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
