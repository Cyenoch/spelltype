import { and, count, eq, gt } from 'drizzle-orm';
import type { ActivitySummary } from '../shared/protocol';
import type { QueryDatabase } from './db';
import { matchTickets, rooms } from './db/schema';

/**
 * 供首页 `GET /api/activity` 使用的公开活跃度计数器。
 *
 * 现在单个数据库保存了所有房间和排队票据，因此两个计数器都是直接基于业务领域自身生命周期规则的查询
 * ——旧的单对象探测和带 TTL 的发现索引已被彻底弃用，而非保留模拟：
 *
 * - 当且仅当房间阶段为 `playing` 且唯一的战斗截止时间尚未过去时，决斗才算正在进行。
 *   以时钟为准，绝不依赖定时器唤醒：截止时间已过但定时器尚未处理完的对局不计入。
 * - 等待中的玩家是未匹配且 TTL 未过期的有效排队条目。已匹配的票据占用的是席位而非队列位置，
 *   因此绝不计入。
 *
 * 查询结果不携带任何房间 ID、名称、主题或阶段；当读取失败时，`GET /api/activity` 会返回 503，
 * 而不是伪造统计数据。
 */
export async function readActivitySummary(database: QueryDatabase): Promise<ActivitySummary> {
  const now = Date.now();
  const [duels] = await database
    .select({ live: count() })
    .from(rooms)
    .where(and(eq(rooms.phase, 'playing'), gt(rooms.deadline, now)));
  const [waiting] = await database
    .select({ live: count() })
    .from(matchTickets)
    .where(and(eq(matchTickets.state, 'waiting'), gt(matchTickets.expires_at, now)));
  return {
    activeDuels: Number(duels?.live ?? 0),
    waitingPlayers: Number(waiting?.live ?? 0),
  };
}
