import { and, asc, eq, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { players } from '../../db/schema';
import type { PlayerRow } from '../../db/schema';
import type { RoomQuery } from './query';
import { INITIAL_HEALTH, MAX_PRIVATE_PLAYERS } from '../../../shared/protocol';

/**
 * 席位补丁可命名的字段；席位的身份与加入时间在入座后即固定。
 * `input_*`/`draft_epoch` 字段是输入限制门控针对每个席位的资格与指标 ——
 * 由战斗裁决、倒计时流转与比赛重置逻辑写入，绝不可外部注入。
 */
const PLAYER_PATCH_COLUMNS = [
  'slot',
  'slot_expires_at',
  'conn_id',
  'seated',
  'ready',
  'progress',
  'spell_index',
  'spells_cast',
  'hp',
  'max_hp',
  'damage_dealt',
  'correct_chars',
  'attempt_total',
  'error_total',
  'cpm',
  'last_input',
  'eliminated_at',
  'input_opened_at',
  'input_not_before',
  'draft_epoch',
  'input_reset_reason',
  'input_sampled',
  'input_gate_hits',
  'input_recoveries',
  'input_min_completion_ratio',
  'input_overloads',
  'input_recovered_completions',
  'input_recovery_departures',
] as const;

export type PlayerPatch = Partial<Pick<PlayerRow, (typeof PLAYER_PATCH_COLUMNS)[number]>>;

/** 获取单个房间的所有席位，按稳定的席位序号升序排列。 */
export async function listPlayers(db: RoomQuery, roomId: string): Promise<PlayerRow[]> {
  return db.select().from(players).where(eq(players.room_id, roomId)).orderBy(asc(players.slot));
}

export async function getPlayer(
  db: RoomQuery,
  roomId: string,
  userId: string,
): Promise<PlayerRow | null> {
  const rows = await db
    .select()
    .from(players)
    .where(and(eq(players.room_id, roomId), eq(players.user_id, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countPlayers(db: RoomQuery, roomId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(players)
    .where(eq(players.room_id, roomId));
  return rows[0]?.total ?? 0;
}

/**
 * 在序号最小的空闲槽位创建席位。返回该席位，若牌桌已满则返回 `null`。
 * 对于该账户已持有的席位，插入操作为空操作，因此重试加入绝不报错。
 */
export async function insertPlayer(
  db: RoomQuery,
  roomId: string,
  player: { userId: string; username: string; slotExpiresAt: number | null; now: number },
): Promise<PlayerRow | null> {
  const taken = await db
    .select({ slot: players.slot })
    .from(players)
    .where(eq(players.room_id, roomId))
    .orderBy(asc(players.slot));
  const used = new Set(taken.map((row) => row.slot));
  let slot: number | null = null;
  for (let candidate = 0; candidate < MAX_PRIVATE_PLAYERS; candidate++) {
    if (!used.has(candidate)) {
      slot = candidate;
      break;
    }
  }
  if (slot === null) return null;
  await db
    .insert(players)
    .values({
      room_id: roomId,
      user_id: player.userId,
      username: player.username,
      slot,
      joined_at: player.now,
      slot_expires_at: player.slotExpiresAt,
    })
    .onConflictDoNothing();
  return getPlayer(db, roomId, player.userId);
}

/**
 * 仅针对已知字段应用更新补丁，调用方绝不能注入非法字段。
 * 值为 `undefined` 的字段被重置为 `null`，完全符合重置它们的阶段流转行为。
 */
export async function updatePlayer(
  db: RoomQuery,
  roomId: string,
  userId: string,
  patch: PlayerPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) =>
    (PLAYER_PATCH_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const values: Record<string, unknown> = {};
  for (const [key, value] of entries) values[key] = value ?? null;
  await db
    .update(players)
    .set(values)
    .where(and(eq(players.room_id, roomId), eq(players.user_id, userId)));
}

export async function deletePlayer(db: RoomQuery, roomId: string, userId: string): Promise<void> {
  await db.delete(players).where(and(eq(players.room_id, roomId), eq(players.user_id, userId)));
}

export async function deleteAllPlayers(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(players).where(eq(players.room_id, roomId));
}

/** 释放曾为比赛预留但从未实际使用的席位。 */
export async function deleteReservedSeats(db: RoomQuery, roomId: string): Promise<void> {
  await db.delete(players).where(and(eq(players.room_id, roomId), eq(players.seated, 0)));
}

/**
 * 当房间回到开放大厅时重新挂载席位过期时间：玩家未连接的席位现在开始计时过期，
 * 已连接的席位则不过期。若无此机制，已完结对局中保留的席位（在花名册锁定期间清除了过期时间）
 * 将会永远阻塞下一次对局开始。
 */
export async function armLobbySeatExpiry(
  db: RoomQuery,
  roomId: string,
  connectedIds: readonly string[],
  expiresAt: number,
): Promise<void> {
  if (connectedIds.length === 0) {
    await db.update(players).set({ slot_expires_at: expiresAt }).where(eq(players.room_id, roomId));
    return;
  }
  await db
    .update(players)
    .set({ slot_expires_at: expiresAt })
    .where(and(eq(players.room_id, roomId), notInArray(players.user_id, [...connectedIds])));
  await db
    .update(players)
    .set({ slot_expires_at: null })
    .where(and(eq(players.room_id, roomId), inArray(players.user_id, [...connectedIds])));
}

/** 释放所有已过期的席位；返回释放的席位数量。 */
export async function expireSeats(db: RoomQuery, roomId: string, now: number): Promise<number> {
  const removed = await db
    .delete(players)
    .where(
      and(
        eq(players.room_id, roomId),
        isNotNull(players.slot_expires_at),
        lte(players.slot_expires_at, now),
      ),
    )
    .returning({ userId: players.user_id });
  return removed.length;
}

/**
 * 将所有席位重置为赛前全新状态：满血、首个法术、空草稿、统计汇总清零并清除打字资格。
 * 在比赛开始时调用，确保上一场比赛的数据 —— 门控触发、恢复次数、超载次数以及任何残留的资格 ——
 * 绝不会泄漏到下一场比赛中。
 */
export async function resetPlayersForMatch(db: RoomQuery, roomId: string): Promise<void> {
  await db
    .update(players)
    .set({
      progress: 0,
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
      max_hp: INITIAL_HEALTH,
      damage_dealt: 0,
      correct_chars: 0,
      attempt_total: 0,
      error_total: 0,
      cpm: 0,
      last_input: '',
      eliminated_at: null,
      input_opened_at: null,
      input_not_before: null,
      draft_epoch: 0,
      input_reset_reason: null,
      input_sampled: 0,
      input_gate_hits: 0,
      input_recoveries: 0,
      input_min_completion_ratio: null,
      input_overloads: 0,
      input_recovered_completions: 0,
      input_recovery_departures: 0,
    })
    .where(eq(players.room_id, roomId));
}

/** 为全新的大厅清除就绪状态；题目生成失败时保持原就绪状态。 */
export async function clearReady(db: RoomQuery, roomId: string): Promise<void> {
  await db.update(players).set({ ready: 0 }).where(eq(players.room_id, roomId));
}
