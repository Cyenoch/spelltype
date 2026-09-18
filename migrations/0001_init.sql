-- Accounts, sessions and long-term match results.
-- Authoritative live match state lives in Durable Objects; D1 only holds durable account data
-- and the finished-match records written by the room when a match completes.

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

-- One row per account per match; the primary key makes a retried write idempotent.
CREATE TABLE results (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  score INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  cpm INTEGER NOT NULL,
  accuracy REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX results_user_recent ON results (user_id, created_at DESC);
