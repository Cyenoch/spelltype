import { asc, count, eq, ilike } from 'drizzle-orm';
import type { AdminBook, AdminBookDetail, AdminPage } from '../../shared/admin';
import type { QueryDatabase } from '../db';
import { spellBookCache } from '../db/schema';
import { ADMIN_PAGE_SIZE, searchPattern, toNumber } from './page';
import { countAdminThemeMatches, listAdminMatches } from './matches';
import { parseStoredCacheBook } from './spells';

function bookOf(
  row: {
    theme: string;
    book: unknown;
    publishedAt: number | null;
    token: string | null;
    leaseExpiresAt: number | null;
  },
  matchCount: number,
  now: number,
): AdminBook {
  const spells = parseStoredCacheBook(row.theme, row.book);
  return {
    theme: row.theme,
    // 法术书缺失（等待生成或租约失效）按 0 条如实呈现，绝不伪造内容。
    spellCount: spells === null ? 0 : spells.length,
    publishedAt: row.publishedAt,
    refreshing: row.token !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now,
    matchCount,
  };
}

/** 法术书列表：以主题为主键稳定排序，页内一次性补齐各主题的对局计数。 */
export async function listAdminBooks(
  database: QueryDatabase,
  search: { page: number; q: string },
): Promise<AdminPage<AdminBook>> {
  const pattern = searchPattern(search);
  const where = pattern === null ? undefined : ilike(spellBookCache.theme, pattern);
  const offset = (search.page - 1) * ADMIN_PAGE_SIZE;

  const [rows, [totalRow]] = await Promise.all([
    database
      .select({
        theme: spellBookCache.theme,
        book: spellBookCache.book,
        publishedAt: spellBookCache.published_at,
        token: spellBookCache.token,
        leaseExpiresAt: spellBookCache.lease_expires_at,
      })
      .from(spellBookCache)
      .where(where)
      .orderBy(asc(spellBookCache.theme))
      .limit(ADMIN_PAGE_SIZE)
      .offset(offset),
    database.select({ total: count() }).from(spellBookCache).where(where),
  ]);

  const matchCounts = await countAdminThemeMatches(
    database,
    rows.map((row) => row.theme),
  );
  const now = Date.now();
  return {
    items: rows.map((row) => bookOf(row, matchCounts.get(row.theme) ?? 0, now)),
    page: search.page,
    pageSize: ADMIN_PAGE_SIZE,
    total: toNumber(totalRow.total),
  };
}

/** 法术书详情：当前缓存内容加上同主题对局的分页列表（不保证同版本法术书）。 */
export async function getAdminBookDetail(
  database: QueryDatabase,
  theme: string,
  page: number,
): Promise<AdminBookDetail | null> {
  const [row] = await database
    .select({
      theme: spellBookCache.theme,
      book: spellBookCache.book,
      publishedAt: spellBookCache.published_at,
      token: spellBookCache.token,
      leaseExpiresAt: spellBookCache.lease_expires_at,
    })
    .from(spellBookCache)
    .where(eq(spellBookCache.theme, theme))
    .limit(1);
  if (row === undefined) return null;

  const [matches, matchCounts] = await Promise.all([
    listAdminMatches(database, { page, q: '', phase: null, theme, userId: null }),
    countAdminThemeMatches(database, [theme]),
  ]);
  const spells = parseStoredCacheBook(theme, row.book);
  return {
    book: bookOf(row, matchCounts.get(theme) ?? 0, Date.now()),
    spells: spells ?? [],
    matches,
  };
}
