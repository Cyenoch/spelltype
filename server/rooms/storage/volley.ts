import { eq } from 'drizzle-orm';
import { combatVolleys } from '../../db/schema';
import type { PendingCast } from '../../db/schema';
import type { RoomQuery } from './query';

export type { PendingCast } from '../../db/schema';

/** 房间打开的单个 100ms 战斗窗口：包含所有已接受并等待其批次边界的施法。 */
export interface PendingVolley {
  matchId: string;
  endsAt: number;
  /** 该窗口伤害可能波及的席位名单，在首次施法时冻结。 */
  roster: string[];
  casts: PendingCast[];
}

/**
 * 读取房间当前打开的单个齐射窗口，若无打开窗口则返回 `null`。
 * 每个房间同时只能存在一个窗口，因此逾期的伤害会在接受任何新输入之前结算。
 * 在普通数据库实例和事务上的表现完全一致。
 */
export async function readVolley(db: RoomQuery, roomId: string): Promise<PendingVolley | null> {
  const rows = await db
    .select()
    .from(combatVolleys)
    .where(eq(combatVolleys.room_id, roomId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { matchId: row.match_id, endsAt: row.ends_at, roster: row.roster, casts: row.casts };
}

/**
 * 调用方在该持久化提交的同一个事务内推进法术光标：
 * 施法意图与光标要么一起生效，要么均不生效。
 * 挂起窗口的标识字段是不可变的 —— 仅有施法列表会增长 ——
 * 因此后写入的操作绝不可能修改已被接受的批次边界。
 */
export async function queueCast(
  db: RoomQuery,
  roomId: string,
  volley: PendingVolley,
  cast: PendingCast,
): Promise<void> {
  const casts = [...volley.casts, cast];
  await db
    .insert(combatVolleys)
    .values({
      room_id: roomId,
      match_id: volley.matchId,
      ends_at: volley.endsAt,
      roster: volley.roster,
      casts,
    })
    .onConflictDoUpdate({
      target: combatVolleys.room_id,
      set: { casts },
    });
}

/** 清除房间的齐射窗口，在结算其伤害的同一个事务中执行。 */
export async function clearVolley(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(combatVolleys).where(eq(combatVolleys.room_id, roomId));
}
