import { MAX_INPUT_CHARS } from '../../shared/protocol';
import type { CombatEvent, ClientMessage } from '../../shared/protocol';
import { charCount, damageOf, diffSnapshot, nextAliveBySeat, spellAt } from '../scoring';
import { finishMatch } from './match';
import type { RoomScope } from './scope';
import { pushSnapshots, sendSnapshotTo } from './snapshots';
import { sendTo } from './sockets';
import type { SocketAuth } from './sockets';
import { appendEvent } from './storage/events';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';

/** The one accepted typing packet: it must name the live match and the player's current spell. */
export type InputFrame = Extract<ClientMessage, { type: 'input' }>;

/**
 * One authoritative typing step.
 *
 * The only accepted packet is the one carrying the player's *current* spell
 * index and the current match id, so a repeated or stale completion — from a
 * resent WebSocket frame, a reconnect replay or a duplicate tab — is dropped
 * whole and can never deal damage twice. A completion applies its damage, any
 * elimination and the attacker's own advancement in one synchronous block:
 * there is no await between them, so no observer can see a half-applied hit.
 */
export async function handleInput(
  scope: RoomScope,
  ws: WebSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<void> {
  const sql = scope.sql;
  const room = getRoom(sql);
  if (!room) return;
  const players = listPlayers(sql);
  const self = players.find((row) => row.user_id === meta.userId);
  if (!self) return;

  if (room.phase !== 'playing' || room.match_id === null) {
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  if (message.matchId !== room.match_id) {
    sendTo(ws, { type: 'error', message: '比赛状态已更新，请以最新法术为准。' });
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  const now = Date.now();
  // The deadline ends the match for everyone: no input is accepted past it.
  if (room.deadline > 0 && now >= room.deadline) {
    await finishMatch(scope, 'timeout', room.deadline);
    return;
  }
  if (self.eliminated_at !== null) {
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  // Replay guard: a stale packet would carry an older spell index.
  if (message.spellIndex !== self.spell_index) {
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  if (charCount(message.text) > MAX_INPUT_CHARS) {
    sendTo(ws, { type: 'error', message: '输入内容过长。' });
    return;
  }
  const book = readSpellBook(room);
  const spell = spellAt(book, self.spell_index);
  if (!spell) return;
  if (!scope.input.allow(meta.connId, now)) return;

  const delta = diffSnapshot(self.last_input, message.text, spell.text);
  const attemptTotal = self.attempt_total + delta.inserted;
  const errorTotal = self.error_total + delta.errors;

  if (message.text !== spell.text) {
    // Partial draft: accepted as the player's snapshot, and its keystrokes are
    // aggregated so accuracy spans the whole match, not one spell.
    updatePlayer(sql, self.user_id, {
      progress: delta.progress,
      last_input: message.text,
      attempt_total: attemptTotal,
      error_total: errorTotal,
    });
    pushSnapshots(scope);
    return;
  }

  const target = nextAliveBySeat(players, self.slot, (seat) => seat.eliminated_at === null);
  if (!target) {
    // No other seat to damage: the match is already decided.
    await finishMatch(scope, 'elimination', now);
    return;
  }
  const damage = Math.min(damageOf(spell.text), target.hp);
  const targetHp = Math.max(0, target.hp - damage);
  const eliminated = targetHp === 0;
  const seq = room.event_seq + 1;

  updatePlayer(
    sql,
    target.user_id,
    eliminated ? { hp: targetHp, eliminated_at: now } : { hp: targetHp },
  );
  updatePlayer(sql, self.user_id, {
    progress: 0,
    last_input: '',
    spell_index: self.spell_index + 1,
    spells_cast: self.spells_cast + 1,
    correct_chars: self.correct_chars + charCount(spell.text),
    // The damage actually dealt — already clamped to the target's remaining
    // health — is what this player is credited with, and it accumulates across
    // spells because every other counter is read from the same live row.
    damage_dealt: self.damage_dealt + damage,
    attempt_total: attemptTotal,
    error_total: errorTotal,
  });
  // The event never carries the completed spell's text: opponents learn how
  // much was dealt, not what was typed.
  const event: CombatEvent = {
    seq,
    at: now,
    attackerId: self.user_id,
    targetId: target.user_id,
    element: spell.element,
    damage,
    targetHp,
    spellIndex: self.spell_index,
    eliminated,
  };
  appendEvent(sql, event);

  const remainingAlive = players.filter((row) =>
    row.user_id === target.user_id ? !eliminated : row.eliminated_at === null,
  ).length;
  if (remainingAlive <= 1) {
    // Last opponent down: the match ends now instead of waiting out the clock.
    await finishMatch(scope, 'elimination', now);
    return;
  }
  pushSnapshots(scope);
}
