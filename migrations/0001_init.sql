-- The whole long-term database: accounts, sessions, finished matches and the live room seats a
-- session holds.
--
-- Authoritative live match state lives in Durable Objects, not here. This file is the current schema
-- in full — there is no legacy column, no nullable variant and no format branch anywhere in the code,
-- the queries or the history response.
--
-- Accounts and sessions are the only identity records. The room's own database is created by the
-- Durable Object itself and never touches these tables.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Only the digest of a session token is stored, never the token itself.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

-- One row per account per match; the primary key makes a retried write idempotent. The room writes it
-- as
--   INSERT INTO results (match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast,
--     correct_chars, duration_ms, rank, cpm, accuracy, created_at)
--   VALUES (12 bound parameters) ON CONFLICT(match_id, user_id) DO NOTHING
-- which keeps a replayed outbox lease a no-op while a genuinely malformed row surfaces as an error
-- instead of being dropped silently.
CREATE TABLE results (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  -- Damage this account dealt to opponents over the match.
  damage_dealt INTEGER NOT NULL,
  -- Health left when the match settled (0 when this account was eliminated).
  hp_remaining INTEGER NOT NULL,
  spells_cast INTEGER NOT NULL,
  correct_chars INTEGER NOT NULL,
  -- Active combat time only, never lobby/generation/countdown.
  duration_ms INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  cpm INTEGER NOT NULL,
  -- `null` when the account produced no counted keystroke: there is no honest 0% or 100% value.
  accuracy REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX results_user_recent ON results (user_id, created_at DESC);

-- Live room seats owned by a session.
--
-- A WebSocket seat outlives an HTTP request: deleting the session row alone would leave the socket
-- authoritative (and its private feed readable) until the room closed on its own. This table records
-- which rooms a session currently holds a seat in, so revoking the session can also close those
-- sockets. Only the token digest appears here, exactly as in `sessions`; never the token itself.
--
-- Revocation protocol this table exists for:
--   1. `revokeSession` runs one D1 batch: `UPDATE sessions SET expires_at = 0` (the tombstone) and
--      `SELECT room_id FROM room_sessions WHERE session_hash = ?`. Zeroing the expiry is what rejects a
--      handshake that races the revocation, because registration only accepts `expires_at > now`.
--   2. Every referenced room is asked to close that session's sockets and must acknowledge. The seat
--      rows stay exactly as they are: they are the retry target if a room refuses.
--   3. Only when every room has acknowledged is the session row deleted. ON DELETE CASCADE then clears
--      these rows, so a seat reference never outlives the session it belongs to.
-- A room that refuses therefore leaves both the tombstone and the references in place, so the next
-- attempt (a retried or concurrent logout for the same bearer) drives the same room set again.

CREATE TABLE room_sessions (
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  PRIMARY KEY (session_hash, room_id)
);
