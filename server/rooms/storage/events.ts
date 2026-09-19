import { and, eq } from 'drizzle-orm';
import { rooms } from '../../db/schema';
import type { RoomRow } from '../../db/schema';
import type { RoomQuery } from './query';
import { COMBAT_EVENT_RING_SIZE } from '../../../shared/protocol';
import type { CombatEvent } from '../../../shared/protocol';

/** 解码存储的环形缓冲区；损坏的值解析为空列表，而不是中断房间读取。 */
function parseEvents(roomId: string, json: string | null): CombatEvent[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as CombatEvent[]) : [];
  } catch (error) {
    console.error(
      '[room] unreadable event ring',
      roomId,
      error instanceof Error ? error.name : typeof error,
    );
    return [];
  }
}

/** 当前比赛最近的伤害事件列表，时间最早的排在最前。 */
export function readEvents(room: RoomRow): CombatEvent[] {
  return parseEvents(room.id, room.events_json);
}

/**
 * 追加整批并发齐射事件并递增其序列号一次。
 * 环形缓冲区保持容量受限；快照绝不会只观察到第一个目标的命中。
 * 在调用方的战斗事务内执行，因此整个事件批次与其记录的伤害一同提交。
 */
export async function appendEvents(
  db: RoomQuery,
  roomId: string,
  incoming: readonly CombatEvent[],
): Promise<void> {
  if (incoming.length === 0) return;
  const rows = await db
    .select({ id: rooms.id, events_json: rooms.events_json })
    .from(rooms)
    .where(and(eq(rooms.id, roomId)))
    .limit(1);
  const current = rows[0];
  if (!current) return;
  const events = parseEvents(current.id, current.events_json);
  events.push(...incoming);
  const ring =
    events.length > COMBAT_EVENT_RING_SIZE
      ? events.slice(events.length - COMBAT_EVENT_RING_SIZE)
      : events;
  await db
    .update(rooms)
    .set({ events_json: JSON.stringify(ring), event_seq: incoming[incoming.length - 1].seq })
    .where(eq(rooms.id, roomId));
}
