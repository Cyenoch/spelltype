import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  notExists,
  sql,
} from 'drizzle-orm';
import type { AdminOverview } from '../../shared/admin';
import type { QueryDatabase } from '../db';
import { accounts, ghosts, results, rooms, spellBookCache } from '../db/schema';
import { toNumber } from './page';
import { listAdminMatches } from './matches';

/** 总览：全局唯一计数与最新条目；对局计数与列表视图共用同一“历史 ∪ 当前”口径。 */
export async function getAdminOverview(database: QueryDatabase): Promise<AdminOverview> {
  const [
    [userCounts],
    [settledCount],
    [unsettledCount],
    [activeCount],
    [bookCount],
    [ghostCount],
    recentUserRows,
    recentMatches,
  ] = await Promise.all([
    database
      .select({
        users: count(),
        admins: sql<number>`count(*) filter (where ${accounts.role} = 'admin')`.mapWith(Number),
      })
      .from(accounts),
    database.select({ total: countDistinct(results.match_id) }).from(results),
    database
      .select({ total: count() })
      .from(rooms)
      .where(
        and(
          isNotNull(rooms.match_id),
          notExists(
            database
              .select({ settled: sql`1` })
              .from(results)
              .where(eq(results.match_id, rooms.match_id)),
          ),
        ),
      ),
    database
      .select({ total: count() })
      .from(rooms)
      .where(
        and(
          isNotNull(rooms.match_id),
          inArray(rooms.phase, ['generating', 'countdown', 'playing']),
        ),
      ),
    database.select({ total: count() }).from(spellBookCache),
    database.select({ total: count() }).from(ghosts),
    database
      .select({
        id: accounts.id,
        username: accounts.username,
        role: accounts.role,
        createdAt: accounts.created_at,
      })
      .from(accounts)
      .orderBy(desc(accounts.created_at), desc(accounts.id))
      .limit(5),
    listAdminMatches(database, { page: 1, q: '', phase: null, theme: null, userId: null }),
  ]);

  return {
    users: toNumber(userCounts.users),
    admins: toNumber(userCounts.admins),
    matches: toNumber(settledCount.total) + toNumber(unsettledCount.total),
    activeMatches: toNumber(activeCount.total),
    books: toNumber(bookCount.total),
    ghosts: toNumber(ghostCount.total),
    recentUsers: recentUserRows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.createdAt,
    })),
    recentMatches: recentMatches.items.slice(0, 5),
  };
}
