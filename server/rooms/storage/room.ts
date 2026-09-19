import { eq } from 'drizzle-orm';
import { rooms, players } from '../../db/schema';
import type { RoomRow } from '../../db/schema';
import type { RoomQuery } from './query';
import type { QueryDatabase } from '../../db';
import type { RoomInit } from '../../../shared/protocol';
import { roomInitSchema } from '../../../shared/validation';
import { RESERVATION_TTL_MS } from '../../../shared/protocol';
import { SEAT_TTL_MS } from '../rules';

/**
 * 房间补丁可指定的字段；房间一旦存在，标识与创建时间戳即固定。
 * `next_alarm_at` 是运行时持有的提示字段，运行时可对其进行更新。
 */
const ROOM_PATCH_COLUMNS = [
  'host_id',
  'phase',
  'deadline',
  'started_at',
  'ended_at',
  'end_reason',
  'match_id',
  'spell_book',
  'events_json',
  'event_seq',
  'error',
  'generation_token',
  'generation_claim',
  'generation_seq',
  'reservation_state',
  'reservation_expires_at',
  'locked',
  'input_policy_version',
  'input_policy_mode',
  'input_min_ms_per_code_point',
  'opponent_kind',
  'ghost_id',
  'opponent_next_at',
  'persistence',
  'persist_attempts',
  'persist_retry_at',
  'next_alarm_at',
] as const;

export type RoomPatch = Partial<Pick<RoomRow, (typeof ROOM_PATCH_COLUMNS)[number]>>;

/** 读取房间的单条数据行，不存在该房间时返回 `null`。 */
export async function getRoom(db: RoomQuery, roomId: string): Promise<RoomRow | null> {
  const rows = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return rows[0] ?? null;
}

/**
 * 仅针对已知字段应用更新补丁，调用方绝不能注入非法字段，且每次写入都会更新 `updated_at`。
 * 值为 `undefined` 的字段被重置为 `null`，沿用旧的补丁语义，
 * 阶段流转会显式重置其不再生效的字段。
 */
export async function updateRoom(db: RoomQuery, roomId: string, patch: RoomPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) =>
    (ROOM_PATCH_COLUMNS as readonly string[]).includes(key),
  );
  if (entries.length === 0) return;
  const values: Record<string, unknown> = {};
  for (const [key, value] of entries) values[key] = value ?? null;
  await db
    .update(rooms)
    .set({ ...values, updated_at: Date.now() })
    .where(eq(rooms.id, roomId));
}

/**
 * 在调用方的事务内创建房间及其初始花名册。
 *
 * 这是匹配系统用于配对快速对局的切面，也是私人房间流程所调用的接口：
 * 它写入房间数据行及每个预留席位，自身不获取准入锁 —— 调用方的事务已持有
 * runtime_control 准入网关 —— 且不会启动任何运行时。
 * 已经存在且结构完全相同的房间行视为幂等重放，符合旧版契约；
 * 任何其他已存在的行均视为调用方代码缺陷。
 *
 * 所有持久化状态均在事务提交前写入完毕，因此后续的唤醒绝不会观察到半创建状态的房间。
 */
export async function createRoom(tx: QueryDatabase, init: RoomInit): Promise<void> {
  const parsed = roomInitSchema.safeParse(init);
  if (!parsed.success) {
    throw new Error(`room:invalid_init:${parsed.error.issues[0]?.path.join('.') || 'shape'}`);
  }
  const { id, host, theme, mode, reserved } = parsed.data;
  const existing = await getRoom(tx, id);
  if (existing) {
    if (existing.mode !== mode) throw new Error('room:already_initialized');
    return;
  }
  const now = Date.now();

  // 在快速房间中，房主合法地出现在 `reserved` 中，因此房主不会被重复计算；
  // 任何其他重复项均会被 schema 验证拒绝。
  const roster = [host, ...(reserved ?? []).filter((entry) => entry.id !== host.id)];
  const seatExpiresAt = mode === 'quick' ? now + RESERVATION_TTL_MS : now + SEAT_TTL_MS;
  const reservationExpiresAt = mode === 'quick' ? now + RESERVATION_TTL_MS : null;

  await tx.insert(rooms).values({
    id,
    host_id: host.id,
    mode,
    theme,
    // 所有房间统一为困难难度：请求不再允许自选难度。
    difficulty: 'hard',
    phase: 'lobby',
    deadline: 0,
    events_json: '[]',
    event_seq: 0,
    generation_seq: 0,
    reservation_state: mode === 'quick' ? 'reserved' : 'none',
    reservation_expires_at: reservationExpiresAt,
    locked: 0,
    persistence: 'idle',
    persist_attempts: 0,
    // 全新创建的大厅必然需要一次唤醒：快速预留会超时，
    // 私人大厅席位在持有者闲置时也会超时。
    next_alarm_at: reservationExpiresAt ?? seatExpiresAt,
    created_at: now,
    updated_at: now,
  });
  for (const [slot, entry] of roster.entries()) {
    await tx.insert(players).values({
      room_id: id,
      user_id: entry.id,
      username: entry.username,
      slot,
      joined_at: now,
      slot_expires_at: seatExpiresAt,
    });
  }
}
