import { and, eq } from 'drizzle-orm';
import { departures } from '../../db/schema';
import type { DepartureRow } from '../../db/schema';
import type { RoomQuery } from './query';

/**
 * 单个账户明确主动离开该房间的持久化记录。
 *
 * 它严格只回答两个问题：“该账户是否已经离开过这里？”（离开响应的幂等性）
 * 以及“该账户是否放弃了*本场*对局？”（重新准入与匹配权限判定）。
 * 赛前离开不携带 match id，早期对局的离开也不再指向当前对局 ——
 * 两者均不能阻碍席位入座，因此该记录绝不会比其归属的对局存活更久。
 */

export async function recordDeparture(
  db: RoomQuery,
  roomId: string,
  departure: { userId: string; matchId: string | null; now: number },
): Promise<void> {
  await db
    .insert(departures)
    .values({
      room_id: roomId,
      user_id: departure.userId,
      match_id: departure.matchId,
      departed_at: departure.now,
    })
    .onConflictDoUpdate({
      target: [departures.room_id, departures.user_id],
      set: { match_id: departure.matchId, departed_at: departure.now },
    });
}

export async function getDeparture(
  db: RoomQuery,
  roomId: string,
  userId: string,
): Promise<DepartureRow | null> {
  const rows = await db
    .select()
    .from(departures)
    .where(and(eq(departures.room_id, roomId), eq(departures.user_id, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 当该账户明确主动放弃了指定对局时返回 true。
 * 在对局存在之前的离开（任一侧 `match_id` 为 null）或早期对局的离开绝不构成阻碍。
 */
export async function abandonedMatch(
  db: RoomQuery,
  roomId: string,
  userId: string,
  matchId: string | null,
): Promise<boolean> {
  if (matchId === null) return false;
  const row = await getDeparture(db, roomId, userId);
  return row !== null && row.match_id === matchId;
}
