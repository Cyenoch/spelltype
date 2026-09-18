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
