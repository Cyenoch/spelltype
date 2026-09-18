import { WS_CLOSE, MATCH_DURATION_MS } from '../../shared/protocol';
import type { RoomScope } from './scope';
import { charCount, inputNotBefore, spellAt } from '../scoring';
import { finishMatchTx } from './match';
import { roomPolicyValid, reportGateStateInvalid } from './input-gate';
import { abortMatch } from './spellbook';
import { endReservation } from './reservation';
import { TIMED_PHASES } from './rules';
import { pushSnapshots } from './snapshots';
import { closeSocket, expiredSockets, reconcileHost, sendTo, unbindSeat } from './sockets';
import { expireSeats, listPlayers, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import { advanceCombat } from './volleys';

/** What one due-transition pass did. */
export interface AdvanceOutcome {
  progressed: boolean;
  /** Set when a generation attempt was claimed; the engine continues it outside the queue. */
  generation?: string;
}

/**
 * Performs at most one due transition (or opens one pending generation attempt).
 * Deadlines come from persisted state, so a late catch-up neither extends nor
 * reopens anything and never double-scores. Each step commits its own
 * transaction; the caller drives the catch-up loop and the snapshot fan-out.
 */
export async function advanceOnce(scope: RoomScope): Promise<AdvanceOutcome> {
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) return { progressed: false };
  const now = scope.now();

  // An expired or revoked session loses its connection (and its seat) even
  // while the room is otherwise idle.
  const expired = expiredSockets(scope.registry, now);
  if (expired.length > 0) {
    for (const { socket } of expired) {
      sendTo(socket, { type: 'error', message: '登录状态已过期，请重新登录。' });
      closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
    }
    await scope.transact(async (tx) => {
      for (const { meta } of expired) await unbindSeat(tx, scope.roomId, meta, now);
      await reconcileHost(tx, scope.roomId, scope.registry);
    });
    await pushSnapshots(scope);
    return { progressed: true };
  }

  if (room.phase === 'generating' && room.generation_token !== null) {
    if (room.generation_claim === room.generation_token) {
      // A previous attempt was interrupted before it could settle. Re-calling
      // the provider would silently re-bill; fail honestly instead. This
      // engine's own, still-awaited attempt is not interrupted: only a claim
      // no live continuation owns reaches the abort.
      if (scope.inFlightGeneration === room.generation_token) return { progressed: false };
      await abortMatch(scope, '出题中断，请重试。');
      return { progressed: true };
    }
    await scope.transact(async (tx) => {
      await updateRoom(tx, scope.roomId, { generation_claim: room.generation_token });
    });
    return { progressed: true, generation: room.generation_token };
  }

  // A due combat batch lands before the clock can settle the match: final-window
  // casts precede the timeout, and a volley that decides the match ends it here.
  if (room.phase === 'playing') {
    if (await advanceCombat(scope, now)) return { progressed: true };
  }

  if (TIMED_PHASES[room.phase] && room.deadline > 0 && now >= room.deadline) {
    if (room.phase === 'countdown') {
      await scope.transact(async (tx) => {
        // Re-read under the fence: a concurrent transition must not reopen a
        // settled match, and the combat clock is derived from the countdown
        // deadline, so a late catch-up shifts the whole match rather than
        // handing out extra time.
        const current = await getRoom(tx, scope.roomId);
        if (
          !current ||
          current.phase !== 'countdown' ||
          current.match_id !== room.match_id ||
          current.deadline !== room.deadline
        )
          return;
        // Combat cannot begin under a policy that was never locked: judging has
        // no source to read. This is state damage, not a configuration default.
        if (!roomPolicyValid(current)) {
          reportGateStateInvalid(current);
          throw new Error('input_gate_state_invalid');
        }
        const openedAt = Date.now();
        const book = readSpellBook(current);
        const alive = (await listPlayers(tx, scope.roomId)).filter(
          (row) => row.eliminated_at === null,
        );
        const eligibility = alive.map((player) => {
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
        for (const entry of eligibility) {
          await updatePlayer(tx, scope.roomId, entry.userId, {
            input_opened_at: openedAt,
            input_not_before: entry.notBefore,
          });
        }
        await updateRoom(tx, scope.roomId, {
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
        await scope.transact((tx) =>
          finishMatchTx(tx, scope.roomId, 'timeout', room.deadline + MATCH_DURATION_MS),
        );
        await pushSnapshots(scope);
        return { progressed: true };
      }
      const roster = await listPlayers(scope.db, scope.roomId);
      if (roster.filter((row) => row.eliminated_at === null).length <= 1) {
        await scope.transact((tx) => finishMatchTx(tx, scope.roomId, 'elimination', room.deadline));
        await pushSnapshots(scope);
        return { progressed: true };
      }
      await pushSnapshots(scope);
      return { progressed: true };
    }
  }

  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    now >= room.reservation_expires_at
  ) {
    await endReservation(scope, 'expired', '匹配超时，请重新匹配。');
    return { progressed: true };
  }

  if (room.locked === 0 && room.phase === 'lobby') {
    let removed = 0;
    await scope.transact(async (tx) => {
      removed = await expireSeats(tx, scope.roomId, now);
      if (removed > 0) await reconcileHost(tx, scope.roomId, scope.registry);
    });
    if (removed > 0) {
      await pushSnapshots(scope);
      return { progressed: true };
    }
  }

  return { progressed: false };
}
