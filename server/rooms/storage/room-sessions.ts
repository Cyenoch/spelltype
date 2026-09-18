import { and, eq, gt } from 'drizzle-orm';
import { roomSessions, sessions } from '../../db/schema';
import type { QueryDatabase } from '../../db';
import type { RoomQuery } from './query';

/**
 * Records that this session holds a live seat in `roomId`, so that revoking the session can also
 * revoke the socket that seat authorizes. Answers `false` when the session no longer exists or has
 * expired: the room must then refuse the handshake, because that registration lost the race against
 * a logout.
 *
 * The live-session check takes a `FOR SHARE` lock on the session row and holds it to the end of the
 * caller's transaction. A concurrent logout's tombstone (`UPDATE sessions SET expires_at = 0`)
 * therefore either commits before the registration reads the row — and the registration refuses —
 * or waits until the registration commits, after which the logout's seat scan sees the fresh
 * `room_sessions` row and revokes the new socket. There is no interleaving where a registration
 * succeeds unseen by a logout.
 */
export async function registerSessionRoom(
  db: QueryDatabase,
  tokenHash: string,
  roomId: string,
  now = Date.now(),
): Promise<boolean> {
  const live = await db
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(and(eq(sessions.token_hash, tokenHash), gt(sessions.expires_at, now)))
    .for('share')
    .limit(1);
  if (live.length === 0) return false;
  await db
    .insert(roomSessions)
    .values({ session_hash: tokenHash, room_id: roomId })
    .onConflictDoNothing();
  return true;
}

/** Drops one seat record. Removing a seat that is already gone is not an error. */
export async function unregisterSessionRoom(
  db: RoomQuery,
  tokenHash: string,
  roomId: string,
): Promise<void> {
  await db
    .delete(roomSessions)
    .where(and(eq(roomSessions.session_hash, tokenHash), eq(roomSessions.room_id, roomId)));
}

/** Answers whether the session token still names a live session. */
export async function sessionIsLive(
  db: RoomQuery,
  tokenHash: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(and(eq(sessions.token_hash, tokenHash), gt(sessions.expires_at, now)))
    .limit(1);
  return rows.length > 0;
}
