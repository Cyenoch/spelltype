import type { EndReason, OpponentKind, Spell } from '../../shared/protocol';
import { BOT_IDLE_MS, INITIAL_HEALTH, MATCH_DURATION_MS } from '../../shared/protocol';
import type { Transaction } from '../db';
import type { PlayerRow, RoomRow } from '../db/schema';
import { getGhost } from '../ghosts';
import { charCount, damageOf, spellAt, survivalRanks } from '../scoring';
import { commitCastTx } from './casts';
import { listPlayers } from './storage/players';
import { updateRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import type { PendingVolley } from './storage/volley';

export function participantKind(room: RoomRow, player: PlayerRow): OpponentKind {
  return player.user_id === room.host_id ? 'human' : room.opponent_kind;
}

function activeHuman(room: RoomRow, human: PlayerRow, at: number): boolean {
  return at - (human.input_opened_at ?? room.started_at ?? at) < BOT_IDLE_MS;
}

/** 相同的房间/法术对始终具有相同的节奏，即使在进程恢复后亦然。 */
function cadence(roomId: string, index: number): number {
  let hash = index + 1;
  for (let i = 0; i < roomId.length; i++) hash = Math.imul(hash ^ roomId.charCodeAt(i), 16777619);
  return 0.85 + ((hash >>> 0) % 351) / 1000;
}

function botDelay(room: RoomRow, human: PlayerRow, index: number, book: readonly Spell[]): number {
  const spell = spellAt(book, index);
  if (!spell || room.input_min_ms_per_code_point === null)
    throw new Error('room:invalid_opponent_spell');
  const elapsed = (human.input_opened_at ?? 0) - (room.started_at ?? 0);
  const measured =
    human.spells_cast > 0 && elapsed > 0 ? (human.correct_chars * 60_000) / elapsed : 220;
  const cpm = Math.max(100, Math.min(420, measured * 0.92));
  const length = charCount(spell.text);
  return Math.ceil(
    Math.max(
      length * room.input_min_ms_per_code_point,
      ((length * 60_000) / cpm) * cadence(room.id, index) + 350,
    ),
  );
}

export async function initializeOpponentTx(tx: Transaction, room: RoomRow): Promise<void> {
  if (room.opponent_kind === 'human' || room.started_at === null) return;
  const roster = await listPlayers(tx, room.id);
  const human = roster.find((row) => row.user_id === room.host_id);
  if (!human) throw new Error('room:missing_human');
  let offset: number;
  if (room.opponent_kind === 'ghost') {
    const ghost = room.ghost_id === null ? null : await getGhost(tx, room.ghost_id);
    if (!ghost || ghost.casts.length === 0) throw new Error('room:missing_ghost');
    offset = ghost.casts[0].at;
  } else {
    offset = botDelay(room, human, 0, readSpellBook(room));
  }
  await updateRoom(tx, room.id, { opponent_next_at: room.started_at + offset });
}

/** 执行单个持久化截止时间，防止被后续输入或批次反超。 */
export async function advanceOpponentTx(
  tx: Transaction,
  room: RoomRow,
  pending: PendingVolley | null,
): Promise<void> {
  const at = room.opponent_next_at;
  if (at === null || room.started_at === null) throw new Error('room:missing_opponent_deadline');
  const roster = await listPlayers(tx, room.id);
  const human = roster.find((row) => row.user_id === room.host_id);
  const opponent = roster.find((row) => row.user_id !== room.host_id);
  if (!human || !opponent) throw new Error('room:missing_opponent');
  if (human.eliminated_at !== null || opponent.eliminated_at !== null || at >= room.deadline) {
    await updateRoom(tx, room.id, { opponent_next_at: null });
    return;
  }
  const book = readSpellBook(room);
  let next: number | null;
  if (room.opponent_kind === 'ghost') {
    const ghost = room.ghost_id === null ? null : await getGhost(tx, room.ghost_id);
    const cast = ghost?.casts[opponent.spell_index];
    if (
      !ghost ||
      !cast ||
      cast.spellIndex !== opponent.spell_index ||
      room.started_at + cast.at !== at
    ) {
      throw new Error('room:invalid_ghost_cursor');
    }
    const following = ghost.casts[opponent.spell_index + 1];
    next = following ? room.started_at + following.at : null;
  } else if (room.opponent_kind === 'bot') {
    const spell = spellAt(book, opponent.spell_index);
    if (!spell) throw new Error('room:missing_spell');
    const power = damageOf(spell.text);
    const committed =
      pending?.casts.reduce(
        (sum, cast) => sum + (cast.attackerId === opponent.user_id ? cast.power : 0),
        0,
      ) ?? 0;
    // 前期的领先优势受限并会逐渐递减消失；已提交的伤害绝不会被收回。
    const openingLead =
      INITIAL_HEALTH * 0.12 * Math.max(0, 1 - (at - room.started_at) / MATCH_DURATION_MS);
    const allowance = human.damage_dealt * 0.9 + openingLead;
    if (
      activeHuman(room, human, at) &&
      (power + committed >= human.hp || opponent.damage_dealt + committed + power > allowance)
    ) {
      await updateRoom(tx, room.id, { opponent_next_at: Math.min(room.deadline, at + 2_000) });
      return;
    }
    next = at + botDelay(room, human, opponent.spell_index + 1, book);
  } else {
    throw new Error('room:unexpected_opponent');
  }
  await commitCastTx(tx, room, opponent, roster, book, pending, at);
  await updateRoom(tx, room.id, {
    opponent_next_at: next !== null && next < room.deadline ? next : null,
  });
}

/** 仅针对机器人的超时判定策略；正常的淘汰与回放结果保持不变。 */
export function terminalReason(
  room: RoomRow,
  roster: readonly PlayerRow[],
  reason: EndReason,
  at: number,
): EndReason {
  if (reason !== 'timeout' || room.opponent_kind !== 'bot') return reason;
  const human = roster.find((row) => row.user_id === room.host_id);
  if (!human) throw new Error('room:missing_human');
  if (human.eliminated_at !== null) return 'elimination';
  return human.spells_cast > 0 && activeHuman(room, human, at) ? 'bot_concession' : 'inactivity';
}

/** 快照与持久化历史记录使用完全相同的专用机器人胜负判定。 */
export function matchRanks(room: RoomRow, roster: readonly PlayerRow[]): Map<string, number> {
  if (
    room.opponent_kind === 'bot' &&
    (room.end_reason === 'bot_concession' || room.end_reason === 'inactivity')
  ) {
    const humanWins = room.end_reason === 'bot_concession';
    return new Map(
      roster.map((row) => [row.user_id, (row.user_id === room.host_id) === humanWins ? 1 : 2]),
    );
  }
  return survivalRanks(
    roster.map((row) => ({ userId: row.user_id, hp: row.hp, eliminatedAt: row.eliminated_at })),
  );
}
