import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { schema } from '../../db/schema';

/**
 * 所有数据库句柄和事务句柄均满足的结构基类 ——
 * 包括 PostgreSQL 驱动与 PGlite。存储辅助函数接收该类型，
 * 以便传递这两种驱动（及其事务）的联合类型时，TypeScript
 * 不会在每次调用时折叠方法签名；`server/db` 中的 `QueryDatabase`
 * 仍是公共参数契约，并且其所有成员均可赋值给此类型。
 */
export type RoomQuery = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
