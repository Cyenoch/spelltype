import { and, count, countDistinct, desc, eq, gt, ilike, isNull, max, or, sql } from 'drizzle-orm';
import type { AdminPage, AdminUser, AdminUserDetail, AdminUserStats } from '../../shared/admin';
import type { QueryDatabase } from '../db';
import { accounts, ghosts, players, results, rooms, sessions } from '../db/schema';
import { ADMIN_PAGE_SIZE, searchPattern, toNumber, toNumberOrNull } from './page';
import { adminResultColumns } from './results';

/** 用户列表：按创建时间由新到旧稳定排序，支持用户名或 ID 的字面子串搜索。 */
export async function listAdminUsers(
  database: QueryDatabase,
  search: { page: number; q: string },
): Promise<AdminPage<AdminUser>> {
  const pattern = searchPattern(search);
  const fuzzy = pattern
    ? or(ilike(accounts.username, pattern), ilike(accounts.id, pattern))
    : undefined;
  const where = fuzzy !== undefined ? fuzzy : undefined;

  const [rows, [totalRow]] = await Promise.all([
    database
      .select({
        id: accounts.id,
        username: accounts.username,
        role: accounts.role,
        createdAt: accounts.created_at,
      })
      .from(accounts)
      .where(where)
      .orderBy(desc(accounts.created_at), desc(accounts.id))
      .limit(ADMIN_PAGE_SIZE)
      .offset((search.page - 1) * ADMIN_PAGE_SIZE),
    database.select({ total: count() }).from(accounts).where(where),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.createdAt,
    })),
    page: search.page,
    pageSize: ADMIN_PAGE_SIZE,
    total: toNumber(totalRow.total),
  };
}

function statsOf(row: {
  games: number;
  wins: number;
  bestCpm: unknown;
  averageCpm: unknown;
  averageAccuracy: unknown;
  damageDealt: unknown;
  spellsCast: unknown;
  correctChars: unknown;
  durationMs: unknown;
  lastPlayedAt: unknown;
}): AdminUserStats {
  return {
    games: toNumber(row.games),
    wins: toNumber(row.wins),
    bestCpm: toNumber(row.bestCpm),
    averageCpm: toNumberOrNull(row.averageCpm),
    averageAccuracy: toNumberOrNull(row.averageAccuracy),
    damageDealt: toNumber(row.damageDealt),
    spellsCast: toNumber(row.spellsCast),
    correctChars: toNumber(row.correctChars),
    durationMs: toNumber(row.durationMs),
    lastPlayedAt: toNumberOrNull(row.lastPlayedAt),
  };
}

/** 用户详情：账户、结算聚合、活跃会话/席位、录制轨迹数量与分页历史。 */
export async function getAdminUserDetail(
  database: QueryDatabase,
  userId: string,
  page: number,
): Promise<AdminUserDetail | null> {
  const [account] = await database
    .select({
      id: accounts.id,
      username: accounts.username,
      role: accounts.role,
      createdAt: accounts.created_at,
    })
    .from(accounts)
    .where(eq(accounts.id, userId))
    .limit(1);
  if (account === undefined) return null;

  const now = Date.now();
  const offset = (page - 1) * ADMIN_PAGE_SIZE;

  const [statRows, historyRows, historyTotals, sessionTotals, ghostTotals, seatRows] =
    await Promise.all([
      database
        .select({
          games: count(),
          wins: sql<number>`count(*) filter (where ${results.rank} = 1)`.mapWith(Number),
          bestCpm: max(results.cpm),
          averageCpm: sql<number | null>`avg(${results.cpm})`,
          averageAccuracy: sql<number | null>`avg(${results.accuracy})`,
          damageDealt: sql<string | null>`sum(${results.damage_dealt})`,
          spellsCast: sql<string | null>`sum(${results.spells_cast})`,
          correctChars: sql<string | null>`sum(${results.correct_chars})`,
          durationMs: sql<string | null>`sum(${results.duration_ms})`,
          lastPlayedAt: max(results.created_at),
        })
        .from(results)
        .where(eq(results.user_id, userId)),
      database
        .select(adminResultColumns)
        .from(results)
        .leftJoin(accounts, eq(accounts.id, results.user_id))
        .where(eq(results.user_id, userId))
        .orderBy(desc(results.created_at), desc(results.match_id))
        .limit(ADMIN_PAGE_SIZE)
        .offset(offset),
      database
        .select({ total: countDistinct(results.match_id) })
        .from(results)
        .where(eq(results.user_id, userId)),
      database
        .select({ total: count() })
        .from(sessions)
        .where(and(eq(sessions.user_id, userId), gt(sessions.expires_at, now))),
      database.select({ total: count() }).from(ghosts).where(eq(ghosts.source_user_id, userId)),
      database
        .select({
          roomId: rooms.id,
          matchId: rooms.match_id,
          phase: rooms.phase,
          theme: rooms.theme,
        })
        .from(players)
        .innerJoin(rooms, eq(rooms.id, players.room_id))
        .where(
          and(
            eq(players.user_id, userId),
            // 未结束的房间才构成活跃席位；席位到期时间的清除/续期由房间生命周期负责。
            sql`${rooms.phase} in ('lobby', 'generating', 'countdown', 'playing')`,
            or(isNull(players.slot_expires_at), gt(players.slot_expires_at, now)),
          ),
        )
        .orderBy(desc(players.joined_at))
        .limit(1),
    ]);

  const seat = seatRows[0];
  return {
    user: {
      id: account.id,
      username: account.username,
      role: account.role,
      createdAt: account.createdAt,
    },
    stats: statsOf(statRows[0]),
    activeSessions: toNumber(sessionTotals[0]?.total),
    ghostCount: toNumber(ghostTotals[0]?.total),
    activeRoom:
      seat === undefined
        ? null
        : {
            roomId: seat.roomId,
            matchId: seat.matchId,
            phase: seat.phase,
            theme: seat.theme,
          },
    history: {
      items: historyRows,
      page,
      pageSize: ADMIN_PAGE_SIZE,
      total: toNumber(historyTotals[0]?.total),
    },
  };
}
