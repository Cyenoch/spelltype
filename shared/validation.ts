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
/** 房间标识：24 位小写十六进制字符。 */
export const roomIdSchema = z.string().regex(/^[0-9a-f]{24}$/, '房间不存在');

/** 跨网络传输时的账户数据：仅包含 ID 和显示名称，绝不包含敏感信息。 */
export const userSchema = z.object({ id: z.string().min(1), username: z.string() });

/**
 * 房间 WebSocket 上的单帧客户端消息。未知字段会被丢弃，`input` 携带房间校验所需的重放防护：
 * `matchId` 用于拒绝上一场对局的数据包，`spellIndex` 用于拒绝过期或重复的数据包，
 * 确保重复发送的完成输入绝不会造成二次伤害。
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
 * 创建房间的载荷数据。这是房间自身的准入规则，因此在此处进行校验，而非盲目信任调用方：
 * 包含一名房主、各预留席位不重复、总人数不超过一桌上限，且快速匹配恰好预留一名对手。
 */
export const roomInitSchema = z
  .object({
    id: roomIdSchema,
    host: userSchema,
    // 保存的主题会广播给所有席位并注入生成提示词，因此房间在通用主题规则之上拒绝控制字符。
    theme: themeSchema.refine((value) => {
      for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code < 32 || code === 127) return false;
      }
      return true;
    }, '主题包含不可用字符'),
    mode: roomModeSchema,
    /** 快速匹配时存在：可仅为对手，或包含两名匹配到的账户。 */
    reserved: z.array(userSchema).optional(),
  })
  .superRefine((init, ctx) => {
    const reserved = init.reserved ?? [];
    if (new Set(reserved.map((entry) => entry.id)).size !== reserved.length) {
      ctx.addIssue({ code: 'custom', message: '预留席位重复', path: ['reserved'] });
    }
    // 房主已隐式包含在 `reserved` 逻辑中，重复传入不会重复占用席位。
    const roster = 1 + reserved.filter((entry) => entry.id !== init.host.id).length;
    if (roster > MAX_PRIVATE_PLAYERS)
      ctx.addIssue({ code: 'custom', message: '席位过多', path: ['reserved'] });
    if (init.mode === 'quick' && roster !== MAX_QUICK_PLAYERS) {
      ctx.addIssue({ code: 'custom', message: '快速对局需要两名玩家', path: ['reserved'] });
    }
  });

export type CreateRoomInput = z.input<typeof createRoomSchema>;
