import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, notExists } from 'drizzle-orm';
import type { AuthenticatedSession } from '../contracts';
import type { QueryDatabase } from '../db';
import { accounts, roomSessions, rooms, sessions } from '../db/schema';
import { SESSION_TTL_MS, type User } from '../../shared/protocol';

export const SESSION_COOKIE = 'spelltype_session';

/**
 * Password KDF: Bun's native argon2id (rust-argon2), running the slow work on a worker thread.
 * Parameters follow the OWASP reference profile for argon2id: m=19 MiB, t=2. The stored record is
 * the PHC string Bun produces (`$argon2id$v=19$m=...,t=...,p=1$...`); there is no bespoke envelope.
 */
const ARGON2ID = { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2 } as const;

/** Bounds keep a tampered `password_hash` row from turning into a denial-of-service on verify. */
const ARGON2_MEMORY_KIB_MAX = 65_536;
const ARGON2_TIME_MAX = 8;

/**
 * True when a stored PHC record is argon2id within the accepted cost bounds, so verification is
 * only ever attempted for hashes the server itself could have written.
 */
function isBoundedArgon2id(stored: string): boolean {
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!match) return false;
  const m = Number(match[1]);
  const t = Number(match[2]);
  const p = Number(match[3]);
  return (
    m >= 1024 && m <= ARGON2_MEMORY_KIB_MAX && t >= 1 && t <= ARGON2_TIME_MAX && p >= 1 && p <= 8
  );
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2ID);
}

/** Constant-time verification of a stored KDF record. Anything malformed is simply a failure. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isBoundedArgon2id(stored)) return false;
  try {
    return await Bun.password.verify(password, stored);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Verification target used when the username does not exist, so login timing stays comparable. */
export function unknownAccountHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

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
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.user_id))
    .where(eq(sessions.token_hash, tokenHash));
  if (!row) return null;
  if (row.expiresAt <= now) {
    // A tombstoned or lapsed session keeps its row while a room still holds its sockets: deleting
    // it here would cascade the seat references away and destroy the retry target of a revocation
    // no release runtime has confirmed yet. Only a session that owes nothing to a room is cleaned.
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
  return { user, tokenHash, expiresAt: row.expiresAt };
}

export interface SessionSeat {
  roomId: string;
  releaseId: string;
}

/**
 * Tombstones the session and reads the seats it still holds in one transaction. The session row
 * lock orders revocation against a concurrent handshake: seat registration takes a shared lock
 * (`SELECT ... FOR SHARE` within the registration transaction — an ordinary MVCC read would not
 * wait), so registration either commits before the scan sees it, or blocks, then
 * re-evaluates against the tombstone and refuses. The runtime/network calls that close sockets
 * run strictly after this transaction closes — never inside it.
 */
export async function planSessionRevocation(
  db: QueryDatabase,
  tokenHash: string,
): Promise<SessionSeat[]> {
  return db.transaction(async (tx) => {
    await tx.update(sessions).set({ expires_at: 0 }).where(eq(sessions.token_hash, tokenHash));
    return tx
      .select({ roomId: roomSessions.room_id, releaseId: rooms.release_id })
      .from(roomSessions)
      .innerJoin(rooms, eq(rooms.id, roomSessions.room_id))
      .where(eq(roomSessions.session_hash, tokenHash));
  });
}

/**
 * Deletes the session once every release runtime has acknowledged socket closure; the foreign keys
 * cascade the seat rows away with it. Idempotent: a missing row is a completed revocation.
 */
export async function deleteSession(db: QueryDatabase, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token_hash, tokenHash));
}

/**
 * Constant-time byte comparison for equal-length secrets (the admin bearer token). Callers compare
 * only fixed-shape hex strings, so length mismatch — which leaks through an early `false` — never
 * occurs for honest requests.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
