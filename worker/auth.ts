import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  SESSION_TTL_MS,
  USERNAME_MAX_CHARS,
  USERNAME_MIN_CHARS
} from '../shared/protocol';
import type { User } from '../shared/protocol';
import type { Env } from './env';
import { HttpError, errorText } from './http';

export const SESSION_COOKIE = 'spelltype_session';

/**
 * Password KDF: scrypt from `node:crypto`, the memory-hard KDF the Workers runtime implements
 * (argon2 is not available there; PBKDF2 was rejected as a weaker fallback).
 * Cost: N=2^15, r=8, p=3 — one of the two parameter sets OWASP recommends for scrypt
 * and the largest that fits comfortably in a Worker isolate's memory budget
 * (128 * N * r = 32 MiB of the runtime's working set, p multiplies CPU cost, not memory).
 */
const KDF_ALGORITHM = 'scrypt';
const KDF_VERSION = 1;
const SCRYPT_BASE = { N: 32768, r: 8, p: 3, keylen: 32 } as const;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;
const SCRYPT_MAX_N = 1 << 17;
const SALT_BYTES = 16;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
  maxmem: number;
}

function scryptMaxMem(N: number, r: number): number {
  return Math.max(SCRYPT_MAX_MEM, 128 * N * r + 1024 * 1024);
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (err, key) =>
    err ? reject(err) : resolve(key)
  );
  return promise;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [algorithm, version, cost, saltPart, keyPart] = parts;
  if (algorithm !== KDF_ALGORITHM || version !== String(KDF_VERSION)) return null;
  const costMatch = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(cost);
  if (!costMatch) return null;
  const N = Number(costMatch[1]);
  const r = Number(costMatch[2]);
  const p = Number(costMatch[3]);
  // Bounds keep a tampered row from turning into a denial-of-service on the isolate.
  if (!Number.isInteger(N) || N < 1024 || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16) return null;
  if (!Number.isInteger(p) || p < 1 || p > 8) return null;
  const salt = Buffer.from(saltPart, 'base64url');
  const key = Buffer.from(keyPart, 'base64url');
  if (salt.length < SALT_BYTES || key.length < 16) return null;
  return {
    params: { N, r, p, keylen: key.length, maxmem: scryptMaxMem(N, r) },
    salt,
    key
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const params: ScryptParams = { ...SCRYPT_BASE, maxmem: scryptMaxMem(SCRYPT_BASE.N, SCRYPT_BASE.r) };
  const key = await derive(password, salt, params);
  const cost = `N=${params.N},r=${params.r},p=${params.p}`;
  return `${KDF_ALGORITHM}$${KDF_VERSION}$${cost}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time verification of a stored KDF record. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

let dummyHash: Promise<string> | null = null;

/** Verification target used when the username does not exist, so login timing stays comparable. */
export function unknownAccountHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

/** Usernames fold to a comparison key; the display form keeps the readable spelling. */
export function normalizeUsername(raw: unknown): { username: string; key: string } | null {
  if (typeof raw !== 'string') return null;
  const username = raw.normalize('NFKC').trim();
  const length = [...username].length;
  if (length < USERNAME_MIN_CHARS || length > USERNAME_MAX_CHARS) return null;
  if (!/^[\p{Script=Han}A-Za-z0-9_]+$/u.test(username)) return null;
  return { username, key: username.toLowerCase() };
}

/** Passwords are never normalized or truncated — only length is bounded. */
export function readPassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const length = [...raw].length;
  if (length < PASSWORD_MIN_CHARS || length > PASSWORD_MAX_CHARS) return null;
  return raw;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionTicket {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export async function createSession(env: Env, userId: string, now = Date.now()): Promise<SessionTicket> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run();
  return { token, tokenHash, expiresAt };
}

export interface ActiveSession {
  user: User;
  tokenHash: string;
  expiresAt: number;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    if (raw.length === 0) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed cookie is simply not a session; it must never turn into a 500.
      return null;
    }
  }
  return null;
}

/**
 * The session digest a request presents, without touching D1.
 *
 * Logout needs this even when no live session is left: revoking a bearer token must not require an
 * active session, because a soft-revoked row and its room references are exactly what a retried or
 * concurrent logout has to drive.
 */
export function sessionHashFromRequest(request: Request): string | null {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return hashToken(token);
}

/** Only the digest of a token is stored, so a database dump cannot be replayed as a session. */
export async function loadSession(env: Env, request: Request, now = Date.now()): Promise<ActiveSession | null> {
  const tokenHash = sessionHashFromRequest(request);
  if (!tokenHash) return null;
  const row = await env.DB.prepare(
    'SELECT s.user_id AS id, s.expires_at AS expiresAt, a.username AS username FROM sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token_hash = ?'
  )
    .bind(tokenHash)
    .first<{ id: string; expiresAt: number; username: string }>();
  if (!row) return null;
  if (row.expiresAt <= now) {
    // A tombstoned or lapsed session keeps its row while a room still holds its sockets: deleting it
    // here would cascade the seat references away and destroy the retry target of a revocation no room
    // has confirmed yet. Only a session that owes nothing to a room is cleaned up.
    await env.DB.prepare(
      'DELETE FROM sessions WHERE token_hash = ? AND NOT EXISTS (SELECT 1 FROM room_sessions WHERE session_hash = ?)'
    )
      .bind(tokenHash, tokenHash)
      .run();
    return null;
  }
  return { user: { id: row.id, username: row.username }, tokenHash, expiresAt: row.expiresAt };
}

export async function requireSession(env: Env, request: Request): Promise<ActiveSession> {
  const session = await loadSession(env, request);
  if (!session) throw new HttpError(401, '登录状态已失效，请重新登录');
  return session;
}

/**
 * Records that this session holds a live seat in `roomId`, so that revoking the session can also
 * revoke the socket that seat authorizes. Answers `false` when the session no longer exists or has
 * expired: the room must then refuse the handshake, because that registration lost the race against a
 * logout. Registration and revocation both run against the session row, so exactly one of them wins.
 */
export async function registerSessionRoom(
  env: Env,
  tokenHash: string,
  roomId: string,
  now = Date.now()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO room_sessions (session_hash, room_id)
       SELECT token_hash, ? FROM sessions WHERE token_hash = ? AND expires_at > ?
       ON CONFLICT(session_hash, room_id) DO UPDATE SET room_id = excluded.room_id`
  )
    .bind(roomId, tokenHash, now)
    .run();
  return result.meta.changes > 0;
}

/** Drops one seat record. Removing a seat that is already gone is not an error. */
export async function unregisterSessionRoom(env: Env, tokenHash: string, roomId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM room_sessions WHERE session_hash = ? AND room_id = ?')
    .bind(tokenHash, roomId)
    .run();
}

/**
 * Revokes a session and closes every room it holds a seat in.
 *
 * The tombstone and the seat read are one D1 batch: the session's expiry is zeroed, which is what
 * rejects a handshake racing this call (registration only accepts `expires_at > now`), and the seat
 * rows are read while the row is still there. Every referenced room is then asked to close this
 * session's sockets and all of them must acknowledge. A single refusal throws 503, so the caller can
 * never report a logout while a socket of that session is still connected, and the tombstone plus the
 * untouched seat rows remain as the retry target: the next attempt — a retried or a concurrent logout
 * for the same bearer — drives exactly the same room set again. Only once every room has acknowledged
 * is the session deleted, and the cascade then removes the seat rows.
 */
export async function revokeSession(env: Env, tokenHash: string): Promise<void> {
  const [, seats] = await env.DB.batch<{ room_id: string }>([
    env.DB.prepare('UPDATE sessions SET expires_at = 0 WHERE token_hash = ?').bind(tokenHash),
    env.DB.prepare('SELECT room_id FROM room_sessions WHERE session_hash = ?').bind(tokenHash)
  ]);
  const acknowledged = await Promise.all(
    seats.results.map((row) => closeRoomSeats(env, row.room_id, tokenHash))
  );
  if (acknowledged.some((ok) => !ok)) throw new HttpError(503, '退出失败，请重试');
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

/** One room, one session: answers whether that room confirmed it closed this session's sockets. */
async function closeRoomSeats(env: Env, roomId: string, tokenHash: string): Promise<boolean> {
  try {
    await env.ROOMS.get(env.ROOMS.idFromName(roomId)).revokeSession(tokenHash);
    return true;
  } catch (err) {
    console.error(`revokeSession: room ${roomId} did not confirm: ${errorText(err)}`);
    return false;
  }
}

export function sessionCookieHeader(ticket: SessionTicket, secure: boolean, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((ticket.expiresAt - now) / 1000));
  return cookieAttributes(`${SESSION_COOKIE}=${ticket.token}`, secure, maxAge);
}

export function clearedSessionCookieHeader(secure: boolean): string {
  return cookieAttributes(`${SESSION_COOKIE}=`, secure, 0);
}

function cookieAttributes(value: string, secure: boolean, maxAge: number): string {
  return `${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
