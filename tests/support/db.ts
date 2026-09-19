/**
 * 测试用例专用的直接数据库访问 —— 通过宿主服务端的 Drizzle 实例进行。
 *
 * 测试脚手架一次性打开 PGlite 数据库，并将同一句柄传递到服务端实例中，
 * 因此本模块对外提供的连接完全等同于产品代码所使用的连接。
 * 需要观测存储层或向存储层注入故障（过期的会话、拒绝写入的结果表、已结算对局留下的记录行）的测试用例，
 * 均通过 Drizzle 针对该句柄执行 —— 它们绝不会重新打开数据库文件，产品代码中也完全不存在任何 SQL 代理。
 */
import { eq, sql } from 'drizzle-orm';
import { results, sessions } from '../../server/db';
import { harness } from './harness';

/** 共享的 Drizzle 实例：服务端的数据库，由测试脚手架一次性打开。 */
export function testDb() {
  return harness().db;
}

/**
 * 将某个账号的所有会话有效期缩短为距离当前 `lifetimeMs` 毫秒 —— 这是老化会话的真实方式，
 * 无需修改浏览器的 Cookie：下一次服务端过期检查就会将其判定为失效。
 */
export async function expireSessionsFor(userId: string, lifetimeMs: number): Promise<void> {
  await testDb()
    .update(sessions)
    .set({ expires_at: Date.now() + lifetimeMs })
    .where(eq(sessions.user_id, userId));
}

/**
 * 通过重命名表让结果沉淀层拒绝写入（通过同一 Drizzle 实例执行 DDL，完全类似于持久化故障注入）。
 * 房间自身的结算逻辑必须如实汇报失败而非谎报同步成功，并必须在存储层恢复后自动重试。
 */
export async function breakResultsSink(): Promise<void> {
  await testDb().execute(sql`ALTER TABLE results RENAME TO results_e2e_backup`);
}

/** 恢复结果表：房间自身的重试定时器将完成其写入 —— 没有任何旁路标记它们为已保存。 */
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

/** 单场对决的所有持久化结果行，与个人资料页及管理员视图读取的格式一致。 */
export async function resultRowsFor(matchId: string) {
  return testDb().select().from(results).where(eq(results.match_id, matchId));
}
