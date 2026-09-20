import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { elementSchema } from '../../shared/validation';
import type { Spell } from '../../shared/protocol';
import type { RoomRow } from '../db/schema';

/**
 * 已入库法术的结构校验：仅约束传输所需的字段形状（字符串与合法元素），
 * 不重复生成侧的篇幅、唯一性等质量规则——管理端如实展示已持久化的内容。
 */
const storedSpellSchema = z.object({
  name: z.string(),
  text: z.string(),
  translation: z.string(),
  element: elementSchema,
});

function corruptBook(label: string, cause: unknown): HTTPException {
  console.error(
    '[admin] unreadable spell book',
    label,
    cause instanceof Error ? cause.name : typeof cause,
  );
  return new HTTPException(500, { message: '法术书数据已损坏，无法读取。' });
}

/** 房间行中的 `spell_book` 为 JSON 文本；缺失返回 null，损坏则显式报错而非静默吞掉。 */
export function parseStoredRoomBook(room: RoomRow): Spell[] | null {
  if (room.spell_book === null || room.spell_book === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(room.spell_book);
  } catch (error) {
    throw corruptBook(room.id, error);
  }
  return parseStoredSpells(parsed, room.id);
}

/** 共享缓存中的 `book` 为 jsonb；缺失返回 null，形状不符则显式报错。 */
export function parseStoredCacheBook(theme: string, book: unknown): Spell[] | null {
  if (book === null || book === undefined) return null;
  return parseStoredSpells(book, theme);
}

/** 对已解析的候选值做结构校验；损坏时记录并抛出 500。 */
export function parseStoredSpells(candidate: unknown, label: string): Spell[] {
  const parsed = z.array(storedSpellSchema).safeParse(candidate);
  if (!parsed.success) throw corruptBook(label, parsed.error.name);
  return parsed.data;
}
