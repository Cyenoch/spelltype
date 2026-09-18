import { MAX_QUICK_PLAYERS } from '../../shared/protocol';
import type { EndReason } from '../../shared/protocol';
import type { Transaction } from '../db';
import type { RoomMatchPolicy } from './scope';
import { accuracyOf, cpmOf, survivalRanks } from '../scoring';
import {
  MIN_PLAYERS,
  reservationIsLive,
  INPUT_MIN_MS_PER_CODE_POINT,
  INPUT_POLICY_VERSION,
} from './rules';
import type { SocketRegistry } from './scope';
import { currentConns, onlineUserIds } from './sockets';
import {
  countPlayers,
  deleteReservedSeats,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from './storage/players';
import { insertResults } from './storage/results';
import { getRoom, updateRoom } from './storage/room';
import type { ResultInsert, RoomRow } from '../db/schema';
import { clearVolley, readVolley } from './storage/volley';
import { reportGateStateInvalid, roomPolicyValid } from './input-gate';

/**
 * Locks the roster and opens one generation attempt for a fresh match. Runs
 * inside the caller's transaction, so the room can never be observed half-
 * started; the answers a refused start writes are the room's own error field.
 *
 * Two immutable admission rules gate the opening: the runtime's global
 * admission (maintenance pauses new matches; a running match and its published
 * quick reservation keep their own clocks) and the input-time mode, which is
 * validated here and locked onto the room row for the whole life of the match.
 */
export async function startMatchTx(
  tx: Transaction,
  roomId: string,
  room: RoomRow,
  policy: RoomMatchPolicy,
): Promise<boolean> {
  if (policy.matchAdmission !== 'open') {
    if (policy.matchAdmission !== 'draining') {
      console.error({ event: 'match_admission_invalid', roomId });
    }
    await updateRoom(tx, roomId, { error: '服务器维护中，暂不开始新对局。' });
    return false;
  }
  const inputMode = policy.inputPolicyMode;
  if (inputMode !== 'observe' && inputMode !== 'enforce') {
    console.error({ event: 'input_policy_config_invalid', roomId });
    await updateRoom(tx, roomId, { error: '施法规则配置异常，暂不能开始新对局。' });
    return false;
  }
  // One critical section owns the whole opening: the stale-seat purge, the
  // readiness count and the match lock commit together or not at all, so a
  // rolled-back start can never leave a half-purged roster behind.
  await deleteReservedSeats(tx, roomId);
  if ((await countPlayers(tx, roomId)) < MIN_PLAYERS) {
    await updateRoom(tx, roomId, { error: '至少需要 2 名已连接玩家才能开始。' });
    return false;
  }
  await resetPlayersForMatch(tx, roomId);
  await clearVolley(tx, roomId);
  const generationSeq = room.generation_seq + 1;
  const matchId = crypto.randomUUID();
  await updateRoom(tx, roomId, {
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
  return true;
}

/**
 * A quick match needs no host action: both reserved seats online is the whole readiness rule.
 * A published reservation keeps its own clock — even after the room's release has been
 * superseded, the posted reservation may still start until its TTL passes while global
 * admission is open.
 */
export async function maybeAutoStartTx(
  tx: Transaction,
  roomId: string,
  registry: SocketRegistry,
  room: RoomRow,
  policy: RoomMatchPolicy,
): Promise<boolean> {
  if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return false;
  if (!reservationIsLive(room, Date.now())) return false;
  const players = await listPlayers(tx, roomId);
  if (players.length !== MAX_QUICK_PLAYERS) return false;
  const online = onlineUserIds(players, await currentConns(tx, roomId, registry));
  if (!players.every((row) => online.has(row.user_id))) return false;
  return startMatchTx(tx, roomId, room, policy);
}

/**
 * Settles the match exactly once, inside the caller's transaction — the frozen
 * speeds, every player's history row and the phase that stops all input commit
 * together or not at all. A storage failure leaves the match running instead of
 * half-settled: no speed without results, no results without an end, and the
 * persisted cast intent stays the recovery source for any window not yet applied.
 *
 * `endedAt` is authoritative rather than the (possibly late) timer: either the
 * instant the last opponent fell or the match deadline. A settled match never
 * accepts input again, and every player's speed is frozen at their own finish
 * — the winner of the clock is not the only player whose time stops.
 */
export async function finishMatchTx(
  tx: Transaction,
  roomId: string,
  reason: EndReason,
  endedAt: number,
): Promise<void> {
  const room = await getRoom(tx, roomId);
  if (!room || room.phase !== 'playing' || room.match_id === null) return;
  // All accepted casts must land before results can become immutable.
  if (await readVolley(tx, roomId)) throw new Error('room:unsettled_volley');
  if (!roomPolicyValid(room)) {
    reportGateStateInvalid(room);
    throw new Error('input_gate_state_invalid');
  }
  const matchId = room.match_id;
  const players = await listPlayers(tx, roomId);
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
  for (const row of players) {
    await updatePlayer(tx, roomId, row.user_id, { cpm: speed.get(row.user_id) ?? 0 });
  }

  const ranks = survivalRanks(
    players.map((row) => ({
      userId: row.user_id,
      hp: row.hp,
      eliminatedAt: row.eliminated_at,
    })),
  );
  const rows: ResultInsert[] = players.map((row) => ({
    match_id: matchId,
    user_id: row.user_id,
    room_id: roomId,
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
  await insertResults(tx, rows);

  // The allocation is consumed by the finished match: a queue ticket can be
  // dropped instead of waiting on a room that will never be playable again.
  // `saved` is the truth the moment this transaction commits — there is no
  // outbox left to drain and no separate save step to retry.
  await updateRoom(tx, roomId, {
    phase: 'finished',
    deadline: 0,
    ended_at: endedAt,
    end_reason: reason,
    reservation_state: 'none',
    reservation_expires_at: null,
    persistence: 'saved',
    persist_retry_at: null,
    persist_attempts: 0,
  });
}
