import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DAMAGE_PER_CHARACTER, INITIAL_HEALTH, WS_PROTOCOL, type Spell } from '../shared/protocol';
import { elementSchema } from '../shared/validation';
import type { QueryDatabase } from './db';
import { ghostCasts, ghosts } from './db/schema';
import type { GhostRow, PlayerRow, ReplayCast, RoomRow } from './db/schema';
import { roomPolicyValid } from './rooms/input-gate';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from './rooms/rules';
import { charCount, inputNotBefore, spellAt } from './scoring';

export type { GhostRow, ReplayCast } from './db/schema';

/**
 * 录制的对局轨迹所依赖的各项规则指纹：包括传输层法术结构、判定节奏的输入底线，
 * 以及施法结算时使用的生命值/伤害常量。选录时仅匹配当前的指纹，因此协议或规则的升级
 * 会使已录制的幽灵自动失效而无需重写——它们只是不再被选中。
 */
export const GHOST_RULES_VERSION = [
  'ghosts.v1',
  WS_PROTOCOL,
  INPUT_POLICY_VERSION,
  String(INPUT_MIN_MS_PER_CODE_POINT),
  String(INITIAL_HEALTH),
  String(DAMAGE_PER_CHARACTER),
].join('+');

/** 选录时仅扫描最新且兼容的若干条幽灵数据，绝不扫描全表。 */
const SELECTION_POOL = 50;

/**
 * 根据 ID 读取一条幽灵数据；若不存在或录制数据不兼容，则返回 `null`。
 * 可按施法时机安全调用：仅为主键查询附加版本过滤，且不会进行超出调用方所需范围的载荷解码。
 */
export async function getGhost(db: QueryDatabase, id: string): Promise<GhostRow | null> {
  const rows = await db
    .select()
    .from(ghosts)
    .where(and(eq(ghosts.id, id), eq(ghosts.rules_version, GHOST_RULES_VERSION)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 为指定账户挑选录制的幽灵对手：在受限且建立索引的最新兼容幽灵池中按从新到旧筛选，
 * 排除该用户自己的录制，并在候选池中均匀随机选取。该池查询仅读取候选 ID，
 * 因此仅对最终选中的单行数据解码其法术书和施法载荷。若无符合条件的数据则返回 `null`，
 * 调用方会回退到 Bot 机器人。
 */
export async function chooseGhost(tx: QueryDatabase, userId: string): Promise<GhostRow | null> {
  const candidates = await tx
    .select({ id: ghosts.id })
    .from(ghosts)
    .where(and(eq(ghosts.rules_version, GHOST_RULES_VERSION), ne(ghosts.source_user_id, userId)))
    .orderBy(desc(ghosts.created_at), ghosts.id)
    .limit(SELECTION_POOL);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return chosen === undefined ? null : getGhost(tx, chosen.id);
}

/**
 * 在调用方的施法确认事务中，记录真人对局中一次已确认的施法。
 * `player` 是光标前进前的玩家席位行（`player.spell_index` 即本次施法在法术书中的光标位置），
 * `now` 为确认完成时的绝对毫秒时间戳，保存为相对于对局 `started_at` 的偏移量。
 * 幽灵和机器人房间不记录任何内容，重复的确认则会被施法主键忽略，避免导致施法失败。
 */
export async function recordCastTx(
  tx: QueryDatabase,
  room: RoomRow,
  player: PlayerRow,
  now: number,
): Promise<void> {
  if (room.opponent_kind !== 'human') return;
  if (room.match_id === null || room.started_at === null) return;
  await tx
    .insert(ghostCasts)
    .values({
      room_id: room.id,
      match_id: room.match_id,
      user_id: player.user_id,
      spell_index: player.spell_index,
      at: now - room.started_at,
    })
    .onConflictDoNothing();
}

/**
 * 在调用方的对局结束事务中，将已完赛对局的真人轨迹归档为不可变的幽灵，并清理房间的临时施法行。
 * 每个轨迹合格的真人席位都会成为独立的幽灵；若有任何检查不通过则跳过该轨迹（绝不半途保留），
 * 其对应的数据行也会一并删除，确保不留下不合规数据。幽灵与机器人房间没有录制数据，只需执行清理删除。
 */
export async function publishGhostsTx(
  tx: QueryDatabase,
  room: RoomRow,
  players: readonly PlayerRow[],
): Promise<void> {
  const matchId = room.match_id;
  const startedAt = room.started_at;
  // 仅在完全遵循幽灵回放策略（当前版本、当前输入底线）的真人房间中，才能产出可信的轨迹；
  // 其他情况仅需执行清理删除。
  if (
    room.opponent_kind === 'human' &&
    matchId !== null &&
    startedAt !== null &&
    roomPolicyValid(room) &&
    room.input_policy_version === INPUT_POLICY_VERSION &&
    room.input_min_ms_per_code_point === INPUT_MIN_MS_PER_CODE_POINT
  ) {
    const book = archiveBook(room);
    if (book !== null) {
      for (const player of players) {
        await publishSeatTx(tx, room, player, book, matchId, startedAt);
      }
    }
  }
  await tx.delete(ghostCasts).where(eq(ghostCasts.room_id, room.id));
}

/**
 * 解码房间不可变的源法术书，仅接受非空且包含完整法术的数组：
 * 轨迹只能针对其最初输入时的完全相同的法术书进行回放，归档行一旦构建便不可更改，后续绝不进行修补。
 */
function archiveBook(room: RoomRow): Spell[] | null {
  if (room.spell_book === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(room.spell_book);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const spell of parsed) {
    if (typeof spell !== 'object' || spell === null) return null;
    const entry = spell as Record<string, unknown>;
    if (
      typeof entry.name !== 'string' ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0 ||
      typeof entry.translation !== 'string' ||
      !elementSchema.safeParse(entry.element).success
    ) {
      return null;
    }
  }
  return parsed as Spell[];
}

/**
 * 在席位轨迹达标时发布为幽灵：该席位必须造成至少相当于一名对手满血的实际伤害，
 * 且其记录的施法必须是法术书完整连续的前缀、输入节奏不得快于当前输入底线允许的极值，
 * 并受对局自身时钟的限制。任何一项检查未通过都会静默跳过该席位。
 */
async function publishSeatTx(
  tx: QueryDatabase,
  room: RoomRow,
  player: PlayerRow,
  book: Spell[],
  matchId: string,
  startedAt: number,
): Promise<void> {
  if (!(player.damage_dealt >= INITIAL_HEALTH)) return;
  const rows = await tx
    .select({ spell_index: ghostCasts.spell_index, at: ghostCasts.at })
    .from(ghostCasts)
    .where(and(eq(ghostCasts.match_id, matchId), eq(ghostCasts.user_id, player.user_id)))
    .orderBy(asc(ghostCasts.spell_index));
  if (rows.length === 0 || rows.length !== player.spells_cast) return;
  // 对局自身的时钟限制了轨迹的上限：阵亡席位截止于其阵亡时刻，幸存者截止于哨声吹响时刻。
  // 超过该界限的伤害属于损坏的轨迹，而非手速极快。
  const latestAt = (player.eliminated_at ?? room.deadline) - startedAt;
  const casts: ReplayCast[] = [];
  let openedAt = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const spell = spellAt(book, index);
    if (row === undefined || row.spell_index !== index || spell === null) return;
    let earliest: number;
    try {
      earliest = inputNotBefore(charCount(spell.text), openedAt, INPUT_MIN_MS_PER_CODE_POINT);
    } catch {
      return;
    }
    if (row.at < earliest || row.at > latestAt) return;
    casts.push({ at: row.at, spellIndex: row.spell_index });
    openedAt = row.at;
  }
  await tx.insert(ghosts).values({
    id: randomUUID(),
    source_user_id: player.user_id,
    theme: room.theme,
    book,
    casts,
    rules_version: GHOST_RULES_VERSION,
    created_at: Date.now(),
  });
}
