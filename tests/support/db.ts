/**
 * Direct database access for the specs — through the owning server's Drizzle instance.
 *
 * The harness opens the PGlite database once and passes the same handle into the server
 * instance, so this module hands out exactly the connection the product code uses. Specs that
 * must observe or fault the storage layer (an expired session, a results sink that refuses
 * writes, the rows a settled match left behind) do it through Drizzle against that handle — they
 * never reopen the database files and there is no SQL proxy anywhere in product code.
 */
import { eq, sql } from 'drizzle-orm';
import { results, sessions } from '../../server/db';
import { harness } from './harness';

/** The shared Drizzle instance: the servers' database, opened once by the harness. */
export function testDb() {
  return harness().db;
}

/**
 * Shortens every session of one account to `lifetimeMs` from now — the honest way to age a
 * session without touching the browser's cookie: the next server-side expiry check fails it.
 */
export async function expireSessionsFor(userId: string, lifetimeMs: number): Promise<void> {
  await testDb()
    .update(sessions)
    .set({ expires_at: Date.now() + lifetimeMs })
    .where(eq(sessions.user_id, userId));
}

/**
 * Makes the results sink refuse writes by moving the table aside (DDL through the same Drizzle
 * instance, exactly like the persistence-era fault injection). The room's own settlement must
 * report the failure instead of claiming a sync, and must retry once the sink heals.
 */
export async function breakResultsSink(): Promise<void> {
  await testDb().execute(sql`ALTER TABLE results RENAME TO results_e2e_backup`);
}

/** Heals the sink: the rooms' own retry alarms finish their writes — nobody marks them saved. */
export async function restoreResultsSink(): Promise<void> {
  await testDb().execute(sql`ALTER TABLE results_e2e_backup RENAME TO results`);
}

export async function resultsSinkIsBroken(): Promise<boolean> {
  const tables = await testDb()
    .select({ name: sql<string>`table_name` })
    .from(sql`information_schema.tables`)
    .where(sql`table_schema = 'public' AND table_name = 'results_e2e_backup'`)
    .limit(1);
  return tables.length === 1;
}

/** Every persisted result row of one match, as the profile and admin views read them. */
export async function resultRowsFor(matchId: string) {
  return testDb().select().from(results).where(eq(results.match_id, matchId));
}
