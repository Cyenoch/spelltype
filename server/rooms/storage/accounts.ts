import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { accounts } from '../../db/schema';
import type { RoomQuery } from './query';

/**
 * 加入时重新查询账户封禁，拒绝握手后已经提交的封禁。
 * 检查后才提交的封禁由运行时关闭已注册的连接，封禁端点等待关闭确认后才成功。
 * 定时封禁以服务器时间为准自动到期；`banned_at` 与 `ban_expires_at` 的成对关系由账户表约束保证。
 */
export async function accountIsBanned(
  db: RoomQuery,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, userId),
        isNotNull(accounts.banned_at),
        or(isNull(accounts.ban_expires_at), gt(accounts.ban_expires_at, now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
