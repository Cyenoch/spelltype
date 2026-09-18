import type { RoomRow } from '../../db/schema';
import type { Spell } from '../../../shared/protocol';

/**
 * The generated, ordered spell book shared by every seat, decoded from the row's JSON. An unreadable
 * book leaves every player without a spell rather than failing the room's read path.
 */
export function readSpellBook(room: RoomRow): Spell[] {
  if (!room.spell_book) return [];
  try {
    const parsed: unknown = JSON.parse(room.spell_book);
    return Array.isArray(parsed) ? (parsed as Spell[]) : [];
  } catch (error) {
    console.error(
      '[room] unreadable spell book',
      room.id,
      error instanceof Error ? error.name : typeof error,
    );
    return [];
  }
}
