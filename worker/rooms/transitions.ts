import { MATCH_DURATION_MS, WS_CLOSE } from '../../shared/protocol';
import { registerDuel } from '../activity';
import { charCount, inputNotBefore, spellAt } from '../scoring';
import { roomPolicyValid, reportGateStateInvalid } from './input-gate';
import { saveResults } from './persistence';
import { endReservation } from './reservation';
import { TIMED_PHASES } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { closeSocket, expiredSockets, reconcileHost, sendTo, unbindSocket } from './sockets';
import { abortMatch, runGeneration } from './spellbook';
import { finishMatch } from './match';
import { expireSeats, listPlayers, updatePlayer } from './storage/players';
import { countUnsavedResults } from './storage/results';
import { getRoom, updateRoom } from './storage/room';
import { advanceCombat } from './volleys';
import { readSpellBook } from './storage/spell-book';

/**
 * Performs at most one due transition (or one pending generation / save
 * retry). Deadlines come from persisted state, so a late alarm catches up
 * without extending or reopening anything and without double scoring.
 */
export async function advanceOnce(scope: RoomScope): Promise<boolean> {
  const room = getRoom(scope.sql);
  if (!room) return false;
  const now = Date.now();

  // An expired or revoked session loses its connection (and its seat) even
  // while the room is otherwise idle.
  const expired = expiredSockets(scope, now);
  if (expired.length > 0) {
    for (const { ws, meta } of expired) {
      sendTo(ws, { type: 'error', message: '登录状态已过期，请重新登录。' });
      closeSocket(ws, WS_CLOSE.sessionExpired, 'session expired');
      unbindSocket(scope, meta);
    }
    reconcileHost(scope);
    pushSnapshots(scope);
    return true;
  }

  if (room.phase === 'generating' && room.generation_token !== null) {
    if (room.generation_claim === room.generation_token) {
      // A previous attempt was interrupted before it could settle. Re-calling
      // the provider would silently re-bill; fail honestly instead.
      abortMatch(scope, '出题中断，请重试。');
      return true;
    }
    updateRoom(scope.sql, { generation_claim: room.generation_token });
    await runGeneration(scope, room);
    return true;
  }

  if (room.phase === 'playing' && (await advanceCombat(scope, now))) return true;

  if (TIMED_PHASES[room.phase] && room.deadline > 0 && now >= room.deadline) {
    if (room.phase === 'countdown') {
      await registerDuel(scope.env, room.id, room.deadline + MATCH_DURATION_MS);
      // The index write yielded: a concurrent transition must not reopen a settled match.
      const current = getRoom(scope.sql);
      if (
        !current ||
        current.phase !== 'countdown' ||
        current.match_id !== room.match_id ||
        current.deadline !== room.deadline
      )
        return false;
      if (!roomPolicyValid(current)) {
        reportGateStateInvalid(current);
        throw new Error('input_gate_state_invalid');
      }
      const openedAt = Date.now();
      const book = readSpellBook(current);
      const eligibility = listPlayers(scope.sql)
        .filter((player) => player.eliminated_at === null)
        .map((player) => {
          const spell = spellAt(book, player.spell_index);
          if (!spell) throw new Error('room:missing_spell');
          return {
            userId: player.user_id,
            notBefore: inputNotBefore(
              charCount(spell.text),
              openedAt,
              current.input_min_ms_per_code_point!,
            ),
          };
        });
      scope.transactionSync(() => {
        for (const player of eligibility) {
          updatePlayer(scope.sql, player.userId, {
            input_opened_at: openedAt,
            input_not_before: player.notBefore,
          });
        }
        // The combat clock is derived from the countdown deadline, so a late
        // alarm shifts the whole match rather than handing out extra time.
        updateRoom(scope.sql, {
          phase: 'playing',
          started_at: room.deadline,
          deadline: room.deadline + MATCH_DURATION_MS,
        });
      });
      // Combat begins: a seat forfeited during generation or countdown is
      // already out, so the survivor rule is checked at this instant too —
      // a duel whose opponent left never waits out the clock.
      // A transition so late that even the match window has passed never
      // publishes an actionable playing snapshot: the playing state commits,
      // then the match ends by its own original deadline — no attack window,
      // no eligibility anyone could act on.
      if (Date.now() >= room.deadline + MATCH_DURATION_MS) {
        await finishMatch(scope, 'timeout', room.deadline + MATCH_DURATION_MS);
        return true;
      }
      const alive = listPlayers(scope.sql).filter((row) => row.eliminated_at === null).length;
      if (alive <= 1) {
        await finishMatch(scope, 'elimination', room.deadline);
        return true;
      }
      pushSnapshots(scope);
      return true;
    }
  }

  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    now >= room.reservation_expires_at
  ) {
    endReservation(scope, 'expired', '匹配超时，请重新匹配。');
    return true;
  }

  if (room.locked === 0 && room.phase === 'lobby') {
    const removed = expireSeats(scope.sql, now);
    if (removed > 0) {
      reconcileHost(scope);
      pushSnapshots(scope);
      return true;
    }
  }

  // The queued rows are the durable truth: whenever any are unsaved and no
  // lease/backoff is running, a write is due — including the `saving` state a
  // reset left behind mid-batch.
  if (
    countUnsavedResults(scope.sql) > 0 &&
    (room.persist_retry_at === null || now >= room.persist_retry_at)
  ) {
    await saveResults(scope);
    pushSnapshots(scope);
    return true;
  }

  return false;
}
