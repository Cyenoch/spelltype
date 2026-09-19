import { COMBAT_BATCH_MS, type Spell } from '../../shared/protocol';
import type { Transaction } from '../db';
import type { PlayerRow, RoomRow } from '../db/schema';
import { recordCastTx } from '../ghosts';
import { charCount, damageOf, inputNotBefore, spellAt } from '../scoring';
import { updatePlayer } from './storage/players';
import { queueCast, type PendingVolley } from './storage/volley';

/** Both authenticated completions and scheduled opponents commit through this path. */
export async function commitCastTx(
  tx: Transaction,
  room: RoomRow,
  self: PlayerRow,
  players: readonly PlayerRow[],
  book: readonly Spell[],
  pending: PendingVolley | null,
  at: number,
): Promise<void> {
  const spell = spellAt(book, self.spell_index);
  const next = spellAt(book, self.spell_index + 1);
  if (
    !spell ||
    !next ||
    room.phase !== 'playing' ||
    room.match_id === null ||
    room.started_at === null ||
    at < room.started_at ||
    at >= room.deadline ||
    self.eliminated_at !== null ||
    room.input_min_ms_per_code_point === null
  )
    throw new Error('room:invalid_cast');
  const windowStart =
    room.started_at + Math.floor((at - room.started_at) / COMBAT_BATCH_MS) * COMBAT_BATCH_MS;
  const volley = pending ?? {
    matchId: room.match_id,
    endsAt: Math.min(room.deadline, windowStart + COMBAT_BATCH_MS),
    roster: players
      .filter((row) => row.eliminated_at === null || row.eliminated_at > windowStart)
      .map((row) => row.user_id),
    casts: [],
  };
  await queueCast(tx, room.id, volley, {
    attackerId: self.user_id,
    spellIndex: self.spell_index,
    element: spell.element,
    power: damageOf(spell.text),
  });
  await recordCastTx(tx, room, self, at);
  await updatePlayer(tx, room.id, self.user_id, {
    progress: 0,
    last_input: '',
    spell_index: self.spell_index + 1,
    spells_cast: self.spells_cast + 1,
    correct_chars: self.correct_chars + charCount(spell.text),
    input_opened_at: at,
    input_not_before: inputNotBefore(charCount(next.text), at, room.input_min_ms_per_code_point),
    draft_epoch: 0,
    input_reset_reason: null,
    input_sampled: 0,
  });
}
