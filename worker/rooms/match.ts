import { MAX_QUICK_PLAYERS } from '../../shared/protocol';
import type { EndReason } from '../../shared/protocol';
import { accuracyOf, cpmOf, survivalRanks } from '../scoring';
import { saveResults } from './persistence';
import {
  INPUT_MIN_MS_PER_CODE_POINT,
  INPUT_POLICY_VERSION,
  MIN_PLAYERS,
  reservationIsLive,
} from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds } from './sockets';
import {
  countPlayers,
  deleteReservedSeats,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from './storage/players';
import { queueResults } from './storage/results';
import { getRoom, updateRoom } from './storage/room';
import type { ResultRow, RoomRow } from './storage/schema';
import { scheduleAlarm } from './timers';
import { clearVolley, readVolley } from './storage/volley';
import { reportGateStateInvalid, roomPolicyValid } from './input-gate';

/** Locks the roster and opens one generation attempt for a fresh match. */
export function startMatch(scope: RoomScope, room: RoomRow): boolean {
  if (scope.env.MATCH_ADMISSION !== 'open') {
    if (scope.env.MATCH_ADMISSION !== 'draining') {
      console.error({ event: 'match_admission_invalid', roomId: room.id });
    }
    updateRoom(scope.sql, { error: '服务器维护中，暂不开始新对局。' });
    return false;
  }
  const inputMode = scope.env.INPUT_POLICY_MODE;
  if (inputMode !== 'observe' && inputMode !== 'enforce') {
    console.error({ event: 'input_policy_config_invalid', roomId: room.id });
    updateRoom(scope.sql, { error: '施法规则配置异常，暂不能开始新对局。' });
    return false;
  }
  // One critical section owns the whole opening: the stale-seat purge, the
  // readiness count and the match lock commit together or not at all, so a
  // rolled-back start can never leave a half-purged roster behind.
  let started = false;
  scope.transactionSync(() => {
    deleteReservedSeats(scope.sql);
    if (countPlayers(scope.sql) < MIN_PLAYERS) {
      updateRoom(scope.sql, { error: '至少需要 2 名已连接玩家才能开始。' });
      return;
    }
    resetPlayersForMatch(scope.sql);
    clearVolley(scope.sql);
    const generationSeq = room.generation_seq + 1;
    const matchId = crypto.randomUUID();
    updateRoom(scope.sql, {
      phase: 'generating',
      deadline: 0,
      started_at: null,
      ended_at: null,
      end_reason: null,
      match_id: matchId,
      spell_book: null,
      events_json: '[]',
      event_seq: 0,
      error: null,
      locked: 1,
      generation_seq: generationSeq,
      generation_token: `${matchId}:${generationSeq}`,
      generation_claim: null,
      reservation_state: 'locked',
      reservation_expires_at: null,
      input_policy_version: INPUT_POLICY_VERSION,
      input_policy_mode: inputMode,
      input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    });
    started = true;
  });
  return started;
}

/** A quick match needs no host action: both reserved seats online is the whole readiness rule. */
export function maybeAutoStart(scope: RoomScope, room: RoomRow): boolean {
  if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return false;
  if (!reservationIsLive(room, Date.now())) return false;
  const players = listPlayers(scope.sql);
  if (players.length !== MAX_QUICK_PLAYERS) return false;
  const online = onlineUserIds(players, currentConns(scope));
  if (!players.every((row) => online.has(row.user_id))) return false;
  return startMatch(scope, room);
}

/**
 * Settles the match exactly once and queues its history rows.
 *
 * `endedAt` is authoritative rather than the (possibly late) alarm: either the
 * instant the last opponent fell or the match deadline. A settled match never
 * accepts input again, and every player's speed is frozen at their own finish
 * — the winner of the clock is not the only player whose time stops.
 */
export async function finishMatch(
  scope: RoomScope,
  reason: EndReason,
  endedAt: number,
): Promise<void> {
  const room = getRoom(scope.sql);
  if (!room || room.phase !== 'playing' || room.match_id === null) return;
  // All accepted casts must land before results can become immutable.
  if (readVolley(scope.sql)) throw new Error('room:unsettled_volley');
  if (!roomPolicyValid(room)) {
    reportGateStateInvalid(room);
    throw new Error('input_gate_state_invalid');
  }
  const matchId = room.match_id;
  const players = listPlayers(scope.sql);
  const startedAt = room.started_at ?? endedAt;
  const durationMs = Math.max(0, endedAt - startedAt);

  const speed = new Map<string, number>();
  for (const row of players) {
    const activeEnd = row.eliminated_at !== null ? Math.min(row.eliminated_at, endedAt) : endedAt;
    speed.set(
      row.user_id,
      cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000)),
    );
  }

  const ranks = survivalRanks(
    players.map((row) => ({
      userId: row.user_id,
      hp: row.hp,
      eliminatedAt: row.eliminated_at,
    })),
  );
  const rows: Omit<ResultRow, 'saved'>[] = players.map((row) => ({
    match_id: matchId,
    user_id: row.user_id,
    theme: room.theme,
    damage_dealt: row.damage_dealt,
    hp_remaining: row.hp,
    spells_cast: row.spells_cast,
    correct_chars: row.correct_chars,
    duration_ms: durationMs,
    rank: ranks.get(row.user_id) ?? players.length,
    cpm: speed.get(row.user_id) ?? 0,
    accuracy: accuracyOf(row.attempt_total, row.error_total),
    input_policy_version: room.input_policy_version!,
    input_policy_mode: room.input_policy_mode,
    input_gate_hits: row.input_gate_hits,
    input_recoveries: row.input_recoveries,
    input_min_completion_ratio: row.input_min_completion_ratio,
    input_overloads: row.input_overloads,
    input_recovered_completions: row.input_recovered_completions,
    input_recovery_departures: row.input_recovery_departures,
    created_at: Date.now(),
  }));

  // One critical section freezes the match: the frozen speeds, the queued
  // history rows and the phase that stops all input commit together, so a
  // storage failure leaves the match running instead of half-settled —
  // no speed without results, no results without an end. Everything after
  // the block is network or delivery.
  scope.transactionSync(() => {
    for (const row of players) {
      updatePlayer(scope.sql, row.user_id, { cpm: speed.get(row.user_id) ?? 0 });
    }
    queueResults(scope.sql, rows);

    // The allocation is consumed by the finished match: a queue ticket can be
    // dropped instead of waiting on a room that will never be playable again.
    updateRoom(scope.sql, {
      phase: 'finished',
      deadline: 0,
      ended_at: endedAt,
      end_reason: reason,
      reservation_state: 'none',
      reservation_expires_at: null,
      persistence: 'saving',
      persist_retry_at: null,
      persist_attempts: 0,
    });
  });
  // The rows are durable before the first external call: arm the recovery
  // timer first so a reset mid-write can never strand them.
  await scheduleAlarm(scope);
  pushSnapshots(scope);
  await saveResults(scope);
  pushSnapshots(scope);
}
