-- Input-time policy columns for match history. 0001 created `results`; this file only adds
-- columns to it, so every existing row keeps its values untouched.
--
-- Pre-policy history is real but it was never measured: each old row gains
-- input_policy_version = 'legacy-unmeasured' with a NULL mode and NULL summaries, so reports can
-- group it separately instead of mistaking it for a measured zero. New rows are written with the
-- policy stamp frozen at match end (see worker/rooms/storage/results.ts queueResults); the
-- (match_id, user_id) primary key keeps a retried outbox write idempotent, exactly as before.
--
-- The room's own database (Durable Objects SQLite) gains the same shapes through its idempotent
-- in-code migration — worker/rooms/storage/schema.ts createSchema() — not through this file.
ALTER TABLE results ADD COLUMN input_policy_version TEXT NOT NULL DEFAULT 'legacy-unmeasured';
ALTER TABLE results ADD COLUMN input_policy_mode TEXT;
ALTER TABLE results ADD COLUMN input_gate_hits INTEGER;
ALTER TABLE results ADD COLUMN input_recoveries INTEGER;
ALTER TABLE results ADD COLUMN input_overloads INTEGER;
ALTER TABLE results ADD COLUMN input_recovered_completions INTEGER;
ALTER TABLE results ADD COLUMN input_recovery_departures INTEGER;
ALTER TABLE results ADD COLUMN input_min_completion_ratio REAL;
