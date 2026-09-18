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
 * Appends one damage event to the bounded ring and advances the match's event
 * sequence. The ring is trimmed by count, so a long match never grows the row.
 */
export function appendEvent(sql: SqlStore, event: CombatEvent): void {
  const room = getRoom(sql);
  if (!room) return;
  const events = readEvents(room);
  events.push(event);
  const ring =
    events.length > COMBAT_EVENT_RING_SIZE
      ? events.slice(events.length - COMBAT_EVENT_RING_SIZE)
      : events;
  updateRoom(sql, { events_json: JSON.stringify(ring), event_seq: event.seq });
}
