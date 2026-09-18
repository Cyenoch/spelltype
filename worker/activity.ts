import type { ActivitySummary } from '../shared/protocol';
import type { Env } from './env';
import { queueStub, roomStub } from './matchmaking/rooms';

/**
 * Candidate rooms come from the connected-session index and an expiring match index. The latter is
 * written before combat starts, so dropping every socket cannot hide an ongoing match. An expired
 * index entry is ignored even if cleanup has not run; a finished room answers false immediately.
 * Waiting players are live, unpaired entries in the matchmaking queue.
 *
 * Every probe is authoritative: a room that answers says yes or no out of its own SQLite, and any
 * probe that fails fails the whole summary instead of quietly counting that room as idle. The result
 * carries no room ids, names, themes or phases.
 */
export async function readActivitySummary(env: Env): Promise<ActivitySummary> {
  const [seats, waitingPlayers] = await Promise.all([
    env.DB.prepare(
      'SELECT room_id FROM room_sessions UNION SELECT room_id FROM room_activity WHERE expires_at > ?',
    )
      .bind(Date.now())
      .all<{ room_id: string }>(),
    queueStub(env).waitingCount(),
  ]);
  const live = await Promise.all(
    (seats.results ?? []).map((row) => roomStub(env, row.room_id).activeDuel()),
  );
  return {
    activeDuels: live.filter(Boolean).length,
    waitingPlayers,
  };
}

/** Publish discovery before combat starts; rematches cannot be shortened by a stale write. */
export async function registerDuel(env: Env, roomId: string, expiresAt: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM room_activity WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare(
      'INSERT INTO room_activity (room_id, expires_at) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET expires_at = MAX(room_activity.expires_at, excluded.expires_at)',
    ).bind(roomId, expiresAt),
  ]);
}
