import { and, eq } from 'drizzle-orm';
import { rooms } from '../../db/schema';
import type { RoomRow } from '../../db/schema';
import type { RoomQuery } from './query';
import { COMBAT_EVENT_RING_SIZE } from '../../../shared/protocol';
import type { CombatEvent } from '../../../shared/protocol';

/** Decodes the stored ring; a damaged value reads as empty instead of breaking a room read. */
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

/** The most recent damage events of the current match, oldest first. */
export function readEvents(room: RoomRow): CombatEvent[] {
  return parseEvents(room.id, room.events_json);
}

/**
 * Appends a whole simultaneous volley and advances its sequence once. The ring
 * remains bounded; no snapshot can observe only the first target's hit. Runs
 * inside the caller's combat transaction, so the whole batch commits with the
 * damage it records.
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
