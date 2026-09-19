import { normalizeSpellInput } from '../../shared/spell-input';
import { MAX_INPUT_CHARS, WS_CLOSE } from '../../shared/protocol';
import type { ClientMessage } from '../../shared/protocol';
import { charCount, diffSnapshot, inputCompletionRatio, spellAt } from '../scoring';
import { finishMatchTx } from './match';
import { INPUT_GATE_ERROR_MESSAGE, inputGateState, reportGateStateInvalid } from './input-gate';
import type { RoomScope } from './scope';
import type { SocketAuth } from './scope';
import { sendSnapshotTo } from './snapshots';
import { closeSocket, sendTo } from './sockets';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import { readVolley } from './storage/volley';
import type { RoomSocket } from '../contracts';
import { advanceCombat } from './volleys';
import type { Transaction } from '../db';
import { commitCastTx } from './casts';

/** The one accepted typing packet: it must name the live match and the player's current spell. */
export type InputFrame = Extract<ClientMessage, { type: 'input' }>;

type InputOutcome =
  | 'retry'
  | 'ignored'
  | 'snapshot'
  | 'push'
  | 'arm'
  | { error: string; snapshot?: boolean; sessionExpired?: boolean };

/**
 * One authoritative typing step.
 *
 * The input quota was spent before this call — `frames` spends it right after ownership, for
 * every legal packet including stale ones, and closes a connection that overspends. What is
 * left is judging: due batches resolve first, then the seat is re-identified (the resolve
 * awaited the event loop, so a replacement, a revocation or an expiry may have landed in
 * between and a stale owner reads nothing and queues nothing), and only then does a coherent
 * stored state get to answer for the packet.
 *
 * The only accepted completion names the current match, the player's current spell index and
 * the current draft epoch, so a repeated or stale completion — from a resent WebSocket frame,
 * a reconnect replay or a duplicate tab — is dropped whole and can never deal damage twice.
 * A completion commits its pending cast and advances the spell cursor in one transaction.
 * Damage and KO are applied later to the whole 100ms window, never to just the first arrival,
 * and a completion rejected by the enforce gate enters no window at all.
 */
export async function handleInput(
  scope: RoomScope,
  socket: RoomSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<void> {
  for (;;) {
    await advanceCombat(scope, Date.now());
    const outcome = await scope.transact((tx) => judge(scope, tx, socket, meta, message));
    if (outcome === 'retry') continue;
    // No socket or snapshot delivery occurs until the judgment transaction commits.
    if (typeof outcome === 'object') {
      sendTo(socket, { type: 'error', message: outcome.error });
      if (outcome.sessionExpired) closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
      if (outcome.snapshot)
        await sendSnapshotTo(scope.db, scope.roomId, scope.registry, socket, meta);
    } else if (outcome === 'snapshot') {
      await sendSnapshotTo(scope.db, scope.roomId, scope.registry, socket, meta);
    } else if (outcome === 'push' || outcome === 'arm') {
      await scope.push();
      if (outcome === 'arm') await scope.arm();
    }
    return;
  }
}

/** Reads and judges under the same runtime/room fence as every resulting write. */
async function judge(
  scope: RoomScope,
  tx: Transaction,
  socket: RoomSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<InputOutcome> {
  const room = await getRoom(tx, scope.roomId);
  if (!room) return 'ignored';
  const players = await listPlayers(tx, scope.roomId);
  const pending = room.phase === 'playing' ? await readVolley(tx, scope.roomId) : null;
  // This is the acceptance instant: lock acquisition and all judgment reads have
  // finished. A crossed boundary must settle before this packet can be judged.
  const now = Date.now();
  if (
    room.phase === 'playing' &&
    (now >= room.deadline ||
      (pending !== null && pending.endsAt <= now) ||
      (room.opponent_next_at !== null && room.opponent_next_at <= now))
  )
    return 'retry';
  if (socket.readyState !== 1) return 'ignored';
  const self = players.find((row) => row.user_id === meta.userId);
  if (!self || self.conn_id !== meta.connId) return 'ignored';
  if (meta.sessionExpires <= now) {
    return { error: '登录状态已过期，请重新登录。', sessionExpired: true };
  }
  if (room.phase !== 'playing' || room.match_id === null) return 'snapshot';
  if (message.matchId !== room.match_id) {
    return { error: '比赛状态已更新，请以最新法术为准。', snapshot: true };
  }
  if (self.eliminated_at !== null || message.spellIndex !== self.spell_index) return 'snapshot';
  if (charCount(message.text) > MAX_INPUT_CHARS) return { error: '输入内容过长。' };
  const book = readSpellBook(room);
  const spell = spellAt(book, self.spell_index);
  if (!spell) {
    reportGateStateInvalid(room);
    return { error: INPUT_GATE_ERROR_MESSAGE, snapshot: true };
  }
  const spellLength = charCount(spell.text);
  const gate = inputGateState(room, self, spellLength);
  if (gate === null) {
    reportGateStateInvalid(room);
    return { error: INPUT_GATE_ERROR_MESSAGE, snapshot: true };
  }
  // A stale epoch is dropped only after the stored gate has been validated.
  if (message.draftEpoch !== self.draft_epoch) return 'snapshot';
  const text = normalizeSpellInput(message.text, spell.text);
  const delta = diffSnapshot(self.last_input, text, spell.text);
  const attemptTotal = self.attempt_total + delta.inserted;
  const errorTotal = self.error_total + delta.errors;

  if (text !== spell.text) {
    await updatePlayer(tx, scope.roomId, self.user_id, {
      progress: delta.progress,
      last_input: text,
      attempt_total: attemptTotal,
      error_total: errorTotal,
      input_reset_reason: text === self.last_input ? self.input_reset_reason : null,
    });
    return 'push';
  }

  if (players.every((row) => row.user_id === self.user_id || row.eliminated_at !== null)) {
    // Earlier accepted casts still land even after their targets depart.
    if (pending) return 'snapshot';
    await finishMatchTx(tx, scope.roomId, 'elimination', Math.min(now, room.deadline));
    return 'arm';
  }

  const tooEarly = now < gate.notBefore;
  const firstSample = self.input_sampled === 0;
  // inputGateState has proved this timestamp coherent; never invent a fallback.
  const openedAt = self.input_opened_at!;
  const ratio = firstSample
    ? inputCompletionRatio(spellLength, openedAt, now, gate.minMsPerCodePoint)
    : self.input_min_completion_ratio;
  const gateHits = self.input_gate_hits + Number(firstSample && tooEarly);
  const minimumRatio =
    ratio === null
      ? self.input_min_completion_ratio
      : Math.min(self.input_min_completion_ratio ?? ratio, ratio);

  if (tooEarly && gate.mode === 'enforce') {
    await updatePlayer(tx, scope.roomId, self.user_id, {
      draft_epoch: self.draft_epoch + 1,
      input_reset_reason: 'completion_too_early',
      input_sampled: 1,
      input_gate_hits: gateHits,
      input_recoveries: self.input_recoveries + 1,
      input_min_completion_ratio: minimumRatio,
    });
    return 'push';
  }
  await commitCastTx(tx, room, self, players, book, pending, now);
  await updatePlayer(tx, scope.roomId, self.user_id, {
    attempt_total: attemptTotal,
    error_total: errorTotal,
    input_gate_hits: gateHits,
    input_min_completion_ratio: minimumRatio,
    input_recovered_completions: self.input_recovered_completions + Number(self.draft_epoch > 0),
  });
  return 'arm';
}
