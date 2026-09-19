import { createHash, randomBytes } from 'node:crypto';
import { and, eq, notExists } from 'drizzle-orm';
import type { AuthenticatedSession } from '../contracts';
import type { QueryDatabase } from '../db';
import { accounts, roomSessions, sessions } from '../db/schema';
import { SESSION_TTL_MS, type User } from '../../shared/protocol';

export const SESSION_COOKIE = 'spelltype_session';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionTicket {
  token: string;
  expiresAt: number;
}

export async function createSession(
  db: QueryDatabase,
  userId: string,
  now = Date.now(),
): Promise<SessionTicket> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .insert(sessions)
    .values({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

/** A session token is 32 random bytes in base64url; nothing else can name a session. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The session digest a cookie value stands for, without touching the database. A missing or
 * malformed value is simply not a session, so it never becomes a lookup or a 500.
 *
 * Logout needs this even when no live session is left: revoking a bearer token must not require an
 * active session, because a soft-revoked row and its room references are exactly what a retried or
 * concurrent logout has to drive.
 */
export function sessionHashFromToken(token: string | undefined): string | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return hashToken(token);
}

/** Only the digest of a token is stored, so a database dump cannot be replayed as a session. */
export async function loadSession(
  db: QueryDatabase,
  tokenHash: string | null,
  now = Date.now(),
): Promise<AuthenticatedSession | null> {
  if (!tokenHash) return null;
  const [row] = await db
    .select({
      id: sessions.user_id,
      expiresAt: sessions.expires_at,
      username: accounts.username,
      role: accounts.role,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.user_id))
    .where(eq(sessions.token_hash, tokenHash));
  if (!row) return null;
  if (row.expiresAt <= now) {
    // A tombstoned or lapsed session keeps its row while a room still holds its sockets: deleting
    // it here would cascade the seat references away and destroy the retry target of a revocation
    // the runtime has not confirmed yet. Only a session that owes nothing to a room is cleaned.
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.token_hash, tokenHash),
          notExists(db.select().from(roomSessions).where(eq(roomSessions.session_hash, tokenHash))),
        ),
      );
    return null;
  }
  const user: User = { id: row.id, username: row.username };
  return { user, role: row.role, tokenHash, expiresAt: row.expiresAt };
}

/**
 * A session tombstone commits before sockets are closed. Handshake registration takes a shared
 * lock on this row: it either finishes first or observes the tombstone and refuses. Runtime calls
 * happen after this statement commits, never while holding its exclusive session lock.
 */
export async function tombstoneSession(db: QueryDatabase, tokenHash: string): Promise<void> {
  await db.update(sessions).set({ expires_at: 0 }).where(eq(sessions.token_hash, tokenHash));
}

/**
 * Deletes the session once the runtime has acknowledged socket closure; the foreign keys
 * cascade the seat rows away with it. Idempotent: a missing row is a completed revocation.
 */
export async function deleteSession(db: QueryDatabase, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token_hash, tokenHash));
}
