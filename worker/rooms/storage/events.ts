import { COMBAT_EVENT_RING_SIZE } from '../../../shared/protocol';
import type { CombatEvent } from '../../../shared/protocol';
import { getRoom, updateRoom } from './room';
import type { RoomRow } from './schema';
import type { SqlStore } from '../../sql';

/** The most recent damage events of the current match, oldest first. */
export function readEvents(room: RoomRow): CombatEvent[] {
  if (!room.events_json) return [];
  try {
    const parsed: unknown = JSON.parse(room.events_json);
    return Array.isArray(parsed) ? (parsed as CombatEvent[]) : [];
  } catch (error) {
    console.error(
      '[room] unreadable event ring',
      room.id,
      error instanceof Error ? error.name : typeof error,
    );
    return [];
  }
}

/**
 * Appends a whole simultaneous volley and advances its sequence once. The ring
 * remains bounded; no snapshot can observe only the first target's hit.
 */
export function appendEvents(sql: SqlStore, incoming: readonly CombatEvent[]): void {
  const room = getRoom(sql);
  if (!room || incoming.length === 0) return;
  const events = readEvents(room);
  events.push(...incoming);
  const ring =
    events.length > COMBAT_EVENT_RING_SIZE
      ? events.slice(events.length - COMBAT_EVENT_RING_SIZE)
      : events;
  updateRoom(sql, {
    events_json: JSON.stringify(ring),
    event_seq: incoming[incoming.length - 1].seq,
  });
}
