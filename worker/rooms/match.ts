import { MAX_QUICK_PLAYERS } from '../../shared/protocol';
import type { EndReason } from '../../shared/protocol';
import { accuracyOf, cpmOf, survivalRanks } from '../scoring';
import { saveResults } from './persistence';
import { MIN_PLAYERS, reservationIsLive } from './rules';
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

/** Locks the roster and opens one generation attempt for a fresh match. */
export function startMatch(scope: RoomScope, room: RoomRow): boolean {
  deleteReservedSeats(scope.sql);
  if (countPlayers(scope.sql) < MIN_PLAYERS) {
    updateRoom(scope.sql, { error: '至少需要 2 名已连接玩家才能开始。' });
    return false;
  }
  resetPlayersForMatch(scope.sql);
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
  });
  return true;
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
  const matchId = room.match_id;
  const players = listPlayers(scope.sql);
  const startedAt = room.started_at ?? endedAt;
  const durationMs = Math.max(0, endedAt - startedAt);

  const speed = new Map<string, number>();
  for (const row of players) {
    const activeEnd = row.eliminated_at !== null ? Math.min(row.eliminated_at, endedAt) : endedAt;
    const cpm = cpmOf(
      row.correct_chars + row.progress,
      Math.max(0, (activeEnd - startedAt) / 1_000),
    );
    speed.set(row.user_id, cpm);
    updatePlayer(scope.sql, row.user_id, { cpm });
  }

  const ranks = survivalRanks(
    players.map((row) => ({
      userId: row.user_id,
      hp: row.hp,
      damageDealt: row.damage_dealt,
      correctChars: row.correct_chars,
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
    created_at: Date.now(),
  }));
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
  // The rows are durable before the first external call: arm the recovery
  // timer first so a reset mid-write can never strand them.
  await scheduleAlarm(scope);
  pushSnapshots(scope);
  await saveResults(scope);
  pushSnapshots(scope);
}
