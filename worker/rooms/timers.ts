import { TIMED_PHASES } from './rules';
import type { RoomScope } from './scope';
import { readSocketMeta } from './sockets';
import { listPlayers } from './storage/players';
import { countUnsavedResults } from './storage/results';
import { getRoom } from './storage/room';
import { readVolley } from './storage/volley';

/**
 * Arms the room's single alarm at the earliest instant something is due, and clears it when nothing
 * is. Deadlines come from persisted state, so the alarm is a wake-up hint rather than a clock of its
 * own: a late fire catches up in `advanceOnce` instead of extending or reopening anything.
 */
export async function scheduleAlarm(scope: RoomScope): Promise<void> {
  const room = getRoom(scope.sql);
  if (!room) {
    await scope.alarm.clear();
    return;
  }
  const timers: number[] = [];
  if (room.phase === 'generating' && room.generation_token !== null) timers.push(Date.now());
  if (TIMED_PHASES[room.phase] && room.deadline > 0) timers.push(room.deadline);
  if (room.phase === 'playing') {
    const volley = readVolley(scope.sql);
    if (volley) timers.push(volley.endsAt);
  }
  if (room.reservation_state === 'reserved' && room.reservation_expires_at !== null)
    timers.push(room.reservation_expires_at);
  // Unsaved result rows always keep a timer: a scheduled lease/backoff when
  // there is one, an immediate attempt otherwise.
  if (countUnsavedResults(scope.sql) > 0) timers.push(room.persist_retry_at ?? Date.now());
  let earliestSessionExpiry = Number.POSITIVE_INFINITY;
  for (const ws of scope.sockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = readSocketMeta(ws);
    if (meta && meta.sessionExpires < earliestSessionExpiry)
      earliestSessionExpiry = meta.sessionExpires;
  }
  if (Number.isFinite(earliestSessionExpiry)) timers.push(earliestSessionExpiry);
  if (room.locked === 0 && room.phase === 'lobby') {
    const seats = listPlayers(scope.sql)
      .map((row) => row.slot_expires_at)
      .filter((value): value is number => value !== null);
    if (seats.length > 0) timers.push(Math.min(...seats));
  }
  if (timers.length === 0) {
    await scope.alarm.clear();
    return;
  }
  await scope.alarm.set(Math.max(Date.now(), Math.min(...timers)));
}
