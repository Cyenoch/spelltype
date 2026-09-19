import { TIMED_PHASES } from './rules';
import type { RoomScope } from './scope';
import { listPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { readVolley } from './storage/volley';
import type { PlayerRow, RoomRow } from '../db/schema';

/**
 * 计算房间所需的最早持久化唤醒截止时间，以及最早的进程局部截止时间。
 * 持久化截止时间保存在 `next_alarm_at` 中并在启动时恢复；
 * 会话过期时间仅存在于套接字注册表中，因此它们与会话套接字一样随进程退出而失效。
 * 进行中的战斗齐射窗口是持久化的：其批处理边界即使在重启后也必须触发，
 * 否则已接受的施法将永远无法落地生效。
 * 该引擎当前正在等待的生成尝试绝不作为独立的唤醒时钟 ——
 * 其延续流程在结算时会重新挂载定时器。
 */
export function computeNextAlarm(
  room: RoomRow,
  players: readonly PlayerRow[],
  earliestSessionExpiry: number | null,
  volleyEndsAt: number | null,
  now: number,
  generationInFlight: string | null,
): { durable: number | null; memory: number | null } {
  const timers: number[] = [];
  if (
    room.phase === 'generating' &&
    room.generation_token !== null &&
    room.generation_token !== generationInFlight
  )
    timers.push(now);
  if (TIMED_PHASES[room.phase] && room.deadline > 0) timers.push(room.deadline);
  if (room.phase === 'playing' && volleyEndsAt !== null) timers.push(volleyEndsAt);
  if (room.phase === 'playing' && room.opponent_next_at !== null)
    timers.push(room.opponent_next_at);
  if (room.reservation_state === 'reserved' && room.reservation_expires_at !== null)
    timers.push(room.reservation_expires_at);
  if (room.locked === 0 && room.phase === 'lobby') {
    for (const seat of players) {
      if (seat.slot_expires_at !== null) timers.push(seat.slot_expires_at);
    }
  }
  const durable = timers.length > 0 ? Math.min(...timers) : null;
  const memory =
    earliestSessionExpiry !== null
      ? durable !== null
        ? Math.min(durable, earliestSessionExpiry)
        : earliestSessionExpiry
      : durable;
  return { durable, memory };
}

/** 房间打开的套接字中最早的会话过期时间（若存在）。 */
export function earliestSessionExpiry(scope: RoomScope, now: number): number | null {
  let earliest: number | null = null;
  for (const socket of scope.registry.list()) {
    if (socket.readyState !== 1) continue;
    const meta = scope.registry.metaOf(socket);
    if (meta && meta.sessionExpires > now && (earliest === null || meta.sessionExpires < earliest))
      earliest = meta.sessionExpires;
  }
  return earliest;
}

/**
 * 根据持久化状态重新计算房间的定时器，并将内存定时器移交给引擎。
 * `next_alarm_at` 是一个持久化提示 —— 截止时间本身保存在房间数据行中 ——
 * 因此该写入是尽力而为的记账操作，陈旧的值在重启后仅会导致一次额外且无害的唤醒。
 */
export async function armRoom(
  scope: RoomScope,
  setTimer: (when: number | null) => void,
): Promise<void> {
  const now = scope.now();
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) {
    await scope.transact(async (tx) => updateRoom(tx, scope.roomId, { next_alarm_at: null }));
    setTimer(null);
    return;
  }
  const players = await listPlayers(scope.db, scope.roomId);
  const volley = room.phase === 'playing' ? await readVolley(scope.db, scope.roomId) : null;
  const { durable, memory } = computeNextAlarm(
    room,
    players,
    earliestSessionExpiry(scope, now),
    volley?.endsAt ?? null,
    now,
    scope.inFlightGeneration,
  );
  if (room.next_alarm_at !== durable) {
    await scope.transact(async (tx) => updateRoom(tx, scope.roomId, { next_alarm_at: durable }));
  }
  setTimer(memory === null ? null : Math.max(now, memory));
}
