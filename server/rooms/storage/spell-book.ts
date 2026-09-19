import type { RoomRow } from '../../db/schema';
import type { Spell } from '../../../shared/protocol';

/**
 * 由数据行中的 JSON 解码得出的、每个席位共享的已生成有序法术书。
 * 法术书无法读取时，会使所有玩家暂时没有法术，而不是直接中断房间的读取路径。
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
