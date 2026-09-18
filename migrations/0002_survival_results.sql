-- Survival-format match results: clean cutover.
--
-- The live game is continuous health combat, and the retired five-round game is no longer supported
-- by any runtime type, query or UI. The pre-survival `results` rows (round placement points in
-- `score`) are therefore dropped and the table is recreated for combat results only, so every stored
-- result has the same shape and there is no legacy column, no nullable combat metric and no format
-- branch anywhere in the code, the queries or the history response.
--
-- Accounts and sessions are untouched: this drops match-result rows only, never an account, a
-- session or an identity.
--
-- The room's result write is
--   INSERT INTO results (match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast,
--     correct_chars, duration_ms, rank, cpm, accuracy, created_at)
--   VALUES (12 bound parameters) ON CONFLICT(match_id, user_id) DO NOTHING
-- which keeps a replayed outbox lease a no-op while a genuinely malformed row surfaces as an error
-- instead of being dropped silently.

DROP TABLE IF EXISTS results;

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
