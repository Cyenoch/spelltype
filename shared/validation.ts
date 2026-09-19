import { z } from 'zod';
import { MAX_PRIVATE_PLAYERS, MAX_QUICK_PLAYERS, MAX_THEME_CHARS } from './protocol';

export const themeSchema = z
  .string({ error: '请输入对战主题。' })
  .trim()
  .refine(
    (value) => Array.from(value).length >= 1 && Array.from(value).length <= MAX_THEME_CHARS,
    `主题需为 1—${MAX_THEME_CHARS} 个字符`,
  );
export const elementSchema = z.enum(['arcane', 'fire', 'ice', 'storm'], {
  error: '元素参数不正确',
});
export const roomModeSchema = z.enum(['private', 'quick'], { error: '房间模式不正确' });
export const createRoomSchema = z.object({ theme: themeSchema });
/** Room identity: 24 lowercase hex characters. */
export const roomIdSchema = z.string().regex(/^[0-9a-f]{24}$/, '房间不存在');

/** An account as it crosses the wire: an id and a display name, never a secret. */
export const userSchema = z.object({ id: z.string().min(1), username: z.string() });

/**
 * One client frame on the room socket. Unknown fields are dropped, and `input` carries the replay
 * guards the room checks: `matchId` rejects packets from an earlier match and `spellIndex` rejects
 * any stale or repeated packet, so a resent completion can never deal damage twice.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), ready: z.boolean() }),
  z.object({ type: z.literal('start') }),
  z.object({
    type: z.literal('input'),
    matchId: z.string(),
    spellIndex: z.number().int().min(0),
    draftEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    text: z.string(),
  }),
  z.object({ type: z.literal('rematch') }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * The payload that creates a room. It is the room's own admission rule, so it is checked here rather
 * than trusted from the caller: one host, unique reserved seats, never more than a full table, and a
 * quick match that reserves exactly one partner.
 */
export const roomInitSchema = z
  .object({
    id: roomIdSchema,
    host: userSchema,
    // A stored theme is replayed to every seat and into the generation prompt, so the room refuses
    // control characters on top of the shared theme rule.
    theme: themeSchema.refine((value) => {
      for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code < 32 || code === 127) return false;
      }
      return true;
    }, '主题包含不可用字符'),
    mode: roomModeSchema,
    /** Present for quick matches: the partner alone, or both matched accounts. */
    reserved: z.array(userSchema).optional(),
  })
  .superRefine((init, ctx) => {
    const reserved = init.reserved ?? [];
    if (new Set(reserved.map((entry) => entry.id)).size !== reserved.length) {
      ctx.addIssue({ code: 'custom', message: '预留席位重复', path: ['reserved'] });
    }
    // The host is implicit in `reserved`, so repeating it is not a second seat.
    const roster = 1 + reserved.filter((entry) => entry.id !== init.host.id).length;
    if (roster > MAX_PRIVATE_PLAYERS)
      ctx.addIssue({ code: 'custom', message: '席位过多', path: ['reserved'] });
    if (init.mode === 'quick' && roster !== MAX_QUICK_PLAYERS) {
      ctx.addIssue({ code: 'custom', message: '快速对局需要两名玩家', path: ['reserved'] });
    }
  });

export type CreateRoomInput = z.input<typeof createRoomSchema>;
