-- Candidate discovery survives disconnected sockets. The room remains authoritative.
CREATE TABLE room_activity (
  room_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX room_activity_expiry ON room_activity (expires_at);
