import type { SQL } from 'drizzle-orm';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { OpponentKind, Phase } from '../../shared/protocol';
import type { AdminMatch, AdminMatchDetail, AdminPage, AdminParticipant } from '../../shared/admin';
import type { QueryDatabase } from '../db';
import { accounts, players, results, rooms, spellBookCache } from '../db/schema';
import { ADMIN_PAGE_SIZE, searchPattern, toNumber, toNumberOrNull } from './page';
import { adminResultColumns } from './results';
import { parseStoredRoomBook } from './spells';

/** 对局列表过滤条件；`null` 表示不过滤。历史对局恒为已结束阶段。 */
export interface AdminMatchFilter {
  page: number;
  q: string;
  phase: Phase | null;
  theme: string | null;
  /** 仅保留该账户作为参与者的对局（历史看结算行，当前看席位）。 */
  userId: string | null;
}

/** 历史对局来源于结算行聚合；当前对局来源于仍未写入结算的房间行，二者并集即全部对局。 */
function settledMatchesFilter(
  filter: AdminMatchFilter,
  pattern: string | null,
  database: QueryDatabase,
): SQL[] {
  const conditions: SQL[] = [];
  const fuzzy = pattern
    ? or(
        ilike(results.match_id, pattern),
        ilike(results.room_id, pattern),
        ilike(results.theme, pattern),
      )
    : undefined;
  if (fuzzy !== undefined) conditions.push(fuzzy);
  if (filter.theme !== null) conditions.push(eq(results.theme, filter.theme));
  if (filter.userId !== null) {
    conditions.push(
      inArray(
        results.match_id,
        database
          .select({ participantMatch: results.match_id })
          .from(results)
          .where(eq(results.user_id, filter.userId)),
      ),
    );
  }
  return conditions;
}

/** 房间行的 match_id 指向其当前对局；已写入结算的对局不再归入“仅当前”来源。 */
function liveMatchConditions(
  filter: AdminMatchFilter,
  pattern: string | null,
  database: QueryDatabase,
): SQL[] {
  const conditions: SQL[] = [
    isNotNull(rooms.match_id),
    notExists(
      database
        .select({ settled: sql`1` })
        .from(results)
        .where(eq(results.match_id, rooms.match_id)),
    ),
  ];
  const fuzzy = pattern
    ? or(ilike(rooms.match_id, pattern), ilike(rooms.id, pattern), ilike(rooms.theme, pattern))
    : undefined;
  if (fuzzy !== undefined) conditions.push(fuzzy);
  if (filter.theme !== null) conditions.push(eq(rooms.theme, filter.theme));
  if (filter.phase !== null) conditions.push(eq(rooms.phase, filter.phase));
  if (filter.userId !== null) {
    conditions.push(
      exists(
        database
          .select({ seat: sql`1` })
          .from(players)
          .where(and(eq(players.room_id, rooms.id), eq(players.user_id, filter.userId))),
      ),
    );
  }
  return conditions;
}

/** 历史与当前对局先在数据库中合并，再统一排序与分页，避免跨来源翻页漏记录。 */
export async function listAdminMatches(
  database: QueryDatabase,
  filter: AdminMatchFilter,
): Promise<AdminPage<AdminMatch>> {
  const pattern = searchPattern({ page: filter.page, q: filter.q });
  const settledConditions = settledMatchesFilter(filter, pattern, database);
  if (filter.phase !== null && filter.phase !== 'finished') settledConditions.push(sql`false`);

  const settled = database
    .select({
      id: sql<string>`${results.match_id}`.as('id'),
      roomId: sql<string>`${results.room_id}`.as('room_id'),
      theme: sql<string>`max(${results.theme})`.as('theme'),
      phase:
        sql<Phase>`case when ${rooms.match_id} = ${results.match_id} then ${rooms.phase} else 'finished' end`.as(
          'phase',
        ),
      mode: rooms.mode,
      opponentKind: sql<OpponentKind>`max(${results.opponent_kind})`.as('opponent_kind'),
      createdAt: sql<number>`max(${results.created_at})`.mapWith(Number).as('created_at'),
      startedAt: sql<
        number | null
      >`case when ${rooms.match_id} = ${results.match_id} then ${rooms.started_at} else null end`
        .mapWith(toNumberOrNull)
        .as('started_at'),
      endedAt: sql<
        number | null
      >`case when ${rooms.match_id} = ${results.match_id} then coalesce(${rooms.ended_at}, max(${results.created_at})) else max(${results.created_at}) end`
        .mapWith(toNumberOrNull)
        .as('ended_at'),
      participantCount: count().as('participant_count'),
    })
    .from(results)
    .innerJoin(rooms, eq(rooms.id, results.room_id))
    .where(and(...settledConditions))
    .groupBy(
      results.match_id,
      results.room_id,
      rooms.mode,
      rooms.match_id,
      rooms.phase,
      rooms.started_at,
      rooms.ended_at,
    );

  const live = database
    .select({
      id: sql<string>`${rooms.match_id}`.as('id'),
      roomId: sql<string>`${rooms.id}`.as('room_id'),
      theme: rooms.theme,
      phase: rooms.phase,
      mode: rooms.mode,
      opponentKind: rooms.opponent_kind,
      createdAt: rooms.created_at,
      startedAt: rooms.started_at,
      endedAt: rooms.ended_at,
      participantCount:
        sql<number>`(select count(*) from ${players} where ${players.room_id} = ${rooms.id})`
          .mapWith(Number)
          .as('participant_count'),
    })
    .from(rooms)
    .where(and(...liveMatchConditions(filter, pattern, database)));

  const combined = unionAll(settled, live).as('admin_matches');
  const [items, totals] = await Promise.all([
    database
      .select()
      .from(combined)
      .orderBy(desc(combined.createdAt), desc(combined.id))
      .limit(ADMIN_PAGE_SIZE)
      .offset((filter.page - 1) * ADMIN_PAGE_SIZE),
    database.select({ total: count() }).from(combined),
  ]);
  return { items, page: filter.page, pageSize: ADMIN_PAGE_SIZE, total: totals[0]?.total ?? 0 };
}

/**
 * 单场对局详情。历史对局的一切信息仅取自结算行；只有房间行的 match_id 仍指向
 * 本场对局时，才允许引用其当前阶段、结束原因与法术书。
 */
export async function getAdminMatchDetail(
  database: QueryDatabase,
  matchId: string,
): Promise<AdminMatchDetail | null> {
  const settledRows = await database
    .select(adminResultColumns)
    .from(results)
    .leftJoin(accounts, eq(accounts.id, results.user_id))
    .where(eq(results.match_id, matchId))
    .orderBy(asc(results.user_id));

  const [currentRoom] = await database
    .select()
    .from(rooms)
    .where(eq(rooms.match_id, matchId))
    .limit(1);

  if (settledRows.length === 0 && currentRoom === undefined) return null;

  const settledAt =
    settledRows.length > 0 ? Math.max(...settledRows.map((row) => row.created_at)) : null;

  // 参与者：已结算对局取结算行（合成席位从不写入结算），否则取房间当前席位
  // ——席位可能没有账户（合成对手 `synthetic:<roomId>`），一律保留并标记 accountExists=false。
  let participants: AdminParticipant[];
  if (settledRows.length > 0) {
    participants = settledRows.map((row) => ({
      userId: row.userId,
      username: row.username,
      accountExists: row.accountExists,
      hp: row.hp_remaining,
      spellsCast: row.spells_cast,
      damageDealt: row.damage_dealt,
      cpm: row.cpm,
    }));
  } else {
    participants = await database
      .select({
        userId: players.user_id,
        username: players.username,
        hp: players.hp,
        spellsCast: players.spells_cast,
        damageDealt: players.damage_dealt,
        cpm: players.cpm,
        accountExists: sql<boolean>`${accounts.id} is not null`,
      })
      .from(players)
      .leftJoin(accounts, eq(accounts.id, players.user_id))
      .where(eq(players.room_id, currentRoom.id))
      .orderBy(asc(players.slot));
  }

  const theme = settledRows[0]?.theme ?? currentRoom.theme;
  const opponentKind = settledRows[0]?.opponent_kind ?? currentRoom.opponent_kind;
  let match: AdminMatch;
  if (settledRows.length === 0) {
    // 未结算的当前对局：一切现状均来自仍持有本场对局的房间行。
    match = {
      id: matchId,
      roomId: currentRoom.id,
      theme,
      phase: currentRoom.phase,
      mode: currentRoom.mode,
      opponentKind,
      createdAt: currentRoom.created_at,
      startedAt: currentRoom.started_at,
      endedAt: currentRoom.ended_at,
      participantCount: participants.length,
    };
  } else if (currentRoom !== undefined) {
    // 已结算且房间仍指向本场对局：房间的结束原因与开赛时间仍归属本场。
    match = {
      id: matchId,
      roomId: currentRoom.id,
      theme,
      phase: currentRoom.phase,
      mode: currentRoom.mode,
      opponentKind,
      createdAt: settledAt ?? currentRoom.created_at,
      startedAt: currentRoom.started_at,
      endedAt: currentRoom.ended_at ?? settledAt,
      participantCount: participants.length,
    };
  } else {
    // 纯历史对局：房间可能已被复用，除不可变的 mode 外不得引用其当前状态。
    const settled = settledRows[0];
    const [modeRow] = await database
      .select({ mode: rooms.mode })
      .from(rooms)
      .where(eq(rooms.id, settled.roomId))
      .limit(1);
    match = {
      id: matchId,
      roomId: settled.roomId,
      theme,
      phase: 'finished',
      mode: modeRow?.mode ?? 'quick',
      opponentKind,
      createdAt: settledAt ?? 0,
      startedAt: null,
      endedAt: settledAt ?? 0,
      participantCount: participants.length,
    };
  }

  // “当前法术书”链接仅在主题存在共享缓存行时有效；自定义主题的书按场次生成，无从链接。
  const [cachedTheme] = await database
    .select({ theme: spellBookCache.theme })
    .from(spellBookCache)
    .where(eq(spellBookCache.theme, theme))
    .limit(1);

  return {
    match,
    endReason: currentRoom?.end_reason ?? null,
    persistence: currentRoom?.persistence ?? null,
    participants,
    results: settledRows,
    spellBook: currentRoom !== undefined ? parseStoredRoomBook(currentRoom) : null,
    currentBookTheme: cachedTheme !== undefined ? theme : null,
    isCurrentRoomMatch: currentRoom !== undefined,
  };
}

/** 各主题的对局总数（历史 ∪ 当前未结算），供法术书列表一次性补齐。 */
export async function countAdminThemeMatches(
  database: QueryDatabase,
  themes: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (themes.length === 0) return counts;
  const [settledRows, liveRows] = await Promise.all([
    database
      .select({ theme: results.theme, total: countDistinct(results.match_id) })
      .from(results)
      .where(inArray(results.theme, themes))
      .groupBy(results.theme),
    database
      .select({ theme: rooms.theme, total: count() })
      .from(rooms)
      .where(
        and(
          isNotNull(rooms.match_id),
          inArray(rooms.theme, themes),
          notExists(
            database
              .select({ settled: sql`1` })
              .from(results)
              .where(eq(results.match_id, rooms.match_id)),
          ),
        ),
      )
      .groupBy(rooms.theme),
  ]);
  for (const row of settledRows) counts.set(row.theme, toNumber(row.total));
  for (const row of liveRows)
    counts.set(row.theme, (counts.get(row.theme) ?? 0) + toNumber(row.total));
  return counts;
}
