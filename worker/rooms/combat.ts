import { normalizeSpellInput } from '../../shared/spell-input';
import { COMBAT_BATCH_MS, MAX_INPUT_CHARS, WS_CLOSE } from '../../shared/protocol';
import type { ClientMessage } from '../../shared/protocol';
import {
  charCount,
  damageOf,
  diffSnapshot,
  inputCompletionRatio,
  inputNotBefore,
  spellAt,
} from '../scoring';
import { INPUT_GATE_ERROR_MESSAGE, inputGateState, reportGateStateInvalid } from './input-gate';
import { finishMatch } from './match';
import type { RoomScope } from './scope';
import { pushSnapshots, sendSnapshotTo } from './snapshots';
import { closeSocket, sendTo } from './sockets';
import type { SocketAuth } from './sockets';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import { queueCast, readVolley } from './storage/volley';
import { scheduleAlarm } from './timers';
import { advanceCombat } from './volleys';

/** The one accepted typing packet: it must name the live match and the player's current spell. */
export type InputFrame = Extract<ClientMessage, { type: 'input' }>;

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
 * A completion commits its pending cast and advances the spell cursor in one synchronous
 * block. Damage and KO are applied later to the whole 100ms window, never to just the first
 * arrival, and a completion rejected by the enforce gate enters no window at all.
 */
export async function handleInput(
  scope: RoomScope,
  ws: WebSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<void> {
  const sql = scope.sql;
  let now;
  let room;
  let pending;
  // Recheck after each await: neither a deadline nor an expired volley may admit this packet.
  do {
    await advanceCombat(scope, Date.now());
    now = Date.now();
    room = getRoom(sql);
    pending = room?.phase === 'playing' ? readVolley(sql) : null;
  } while (
    room?.phase === 'playing' &&
    (now >= room.deadline || (pending !== null && pending.endsAt <= now))
  );

  // The await above released the event loop: this socket may have been replaced, revoked,
  // expired or closed while combat resolved. Ownership is judged again before the seat acts.
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!room) return;
  const players = listPlayers(sql);
  const self = players.find((row) => row.user_id === meta.userId);
  if (!self || self.conn_id !== meta.connId) return;
  if (meta.sessionExpires <= Date.now()) {
    sendTo(ws, { type: 'error', message: '登录状态已过期，请重新登录。' });
    closeSocket(ws, WS_CLOSE.sessionExpired, 'session expired');
    return;
  }

  if (room.phase !== 'playing' || room.match_id === null) {
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  if (message.matchId !== room.match_id) {
    sendTo(ws, { type: 'error', message: '比赛状态已更新，请以最新法术为准。' });
    sendSnapshotTo(scope, ws, meta);
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
  if (!spell) {
    // An empty book or a vanished current spell is state damage, never a free
    // zero-character cast: refuse with the gate error and let the snapshot —
    // which reports the same damage — stop the client from resubmitting.
    reportGateStateInvalid(room);
    sendTo(ws, { type: 'error', message: INPUT_GATE_ERROR_MESSAGE });
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  const spellLength = charCount(spell.text);
  const gate = inputGateState(room, self, spellLength);
  if (gate === null) {
    reportGateStateInvalid(room);
    sendTo(ws, { type: 'error', message: INPUT_GATE_ERROR_MESSAGE });
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  // The epoch is judged only once the stored state it names is proven coherent.
  if (message.draftEpoch !== self.draft_epoch) {
    sendSnapshotTo(scope, ws, meta);
    return;
  }

  const text = normalizeSpellInput(message.text, spell.text);
  const delta = diffSnapshot(self.last_input, text, spell.text);
  const attemptTotal = self.attempt_total + delta.inserted;
  const errorTotal = self.error_total + delta.errors;

  if (text !== spell.text) {
    // Partial draft: accepted as the player's snapshot, and its keystrokes are
    // aggregated so accuracy spans the whole match, not one spell.
    updatePlayer(sql, self.user_id, {
      progress: delta.progress,
      last_input: text,
      attempt_total: attemptTotal,
      error_total: errorTotal,
      input_reset_reason: text === self.last_input ? self.input_reset_reason : null,
    });
    pushSnapshots(scope);
    return;
  }

  if (players.every((row) => row.user_id === self.user_id || row.eliminated_at !== null)) {
    if (pending) {
      // Earlier legal casts still land at their batch boundary, even after departure.
      sendSnapshotTo(scope, ws, meta);
      return;
    }
    // No target left standing: the existing survivor rule settles the match
    // instead of manufacturing a completion, a recovery record or a one-roster
    // volley. The completion itself is not recorded.
    await finishMatch(scope, 'elimination', Math.min(now, room.deadline));
    return;
  }

  const tooEarly = now < gate.notBefore;
  const firstSample = self.input_sampled === 0;
  const ratio = firstSample
    ? inputCompletionRatio(spellLength, self.input_opened_at!, now, gate.minMsPerCodePoint)
    : self.input_min_completion_ratio;
  const gateHits = self.input_gate_hits + Number(firstSample && tooEarly);
  const minimumRatio =
    ratio === null
      ? self.input_min_completion_ratio
      : Math.min(self.input_min_completion_ratio ?? ratio, ratio);

  if (tooEarly && gate.mode === 'enforce') {
    scope.transactionSync(() => {
      updatePlayer(sql, self.user_id, {
        draft_epoch: self.draft_epoch + 1,
        input_reset_reason: 'completion_too_early',
        input_sampled: 1,
        input_gate_hits: gateHits,
        input_recoveries: self.input_recoveries + 1,
        input_min_completion_ratio: minimumRatio,
      });
    });
    sendSnapshotTo(scope, ws, meta);
    return;
  }
  const nextSpell = spellAt(book, self.spell_index + 1);
  if (!nextSpell) throw new Error('room:missing_spell');
  const notBefore = inputNotBefore(charCount(nextSpell.text), now, gate.minMsPerCodePoint);

  const startedAt = room.started_at ?? now;
  const windowStart = startedAt + Math.floor((now - startedAt) / COMBAT_BATCH_MS) * COMBAT_BATCH_MS;
  const volley = pending ?? {
    matchId: room.match_id,
    endsAt: Math.min(room.deadline, windowStart + COMBAT_BATCH_MS),
    // A departure during an otherwise empty window must not amplify later casts.
    roster: players
      .filter((player) => player.eliminated_at === null || player.eliminated_at > windowStart)
      .map((player) => player.user_id),
    casts: [],
  };
  scope.transactionSync(() => {
    queueCast(sql, volley, {
      attackerId: self.user_id,
      spellIndex: self.spell_index,
      element: spell.element,
      power: damageOf(spell.text),
    });
    updatePlayer(sql, self.user_id, {
      progress: 0,
      last_input: '',
      spell_index: self.spell_index + 1,
      spells_cast: self.spells_cast + 1,
      correct_chars: self.correct_chars + spellLength,
      attempt_total: attemptTotal,
      error_total: errorTotal,
      input_opened_at: now,
      input_not_before: notBefore,
      draft_epoch: 0,
      input_reset_reason: null,
      input_sampled: 0,
      input_gate_hits: gateHits,
      input_min_completion_ratio: minimumRatio,
      input_recovered_completions: self.input_recovered_completions + Number(self.draft_epoch > 0),
    });
  });
  pushSnapshots(scope);
  await scheduleAlarm(scope);
}
