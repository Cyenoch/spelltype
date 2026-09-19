import { results } from '../../db/schema';
import type { ResultInsert } from '../../db/schema';
import type { RoomQuery } from './query';

/**
 * 在调用方的事务内为每个席位写入一条历史记录行 —— 与关闭比赛属于同一个事务。
 * `(match_id, user_id)` 是幂等性键，因此重试的结算操作 —— 重放相同对局 ID 的再来一局、
 * 与截止时间竞态的第二个调用方 —— 绝不会存入第二行或覆盖第一行。
 * 没有发件箱机制，也没有 `saved` 标志：提交即代表已保存。
 */
export async function insertResults(db: RoomQuery, rows: readonly ResultInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(results)
    .values([...rows])
    .onConflictDoNothing();
}
