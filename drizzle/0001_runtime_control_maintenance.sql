-- The release→maintenance cutover: one forward migration, never a rewritten baseline.
--
-- Statement order is load-bearing. The lock boundary runs FIRST: one LOCK TABLE statement takes
-- ACCESS EXCLUSIVE on the whole legacy state atomically, in the legacy row-lock order
-- (control → versions → rooms → tickets). Without it the plain-SELECT guards below have a
-- TOCTOU window: an old writer or lease acquirer could slip in between the counts and the
-- DROPs — claiming ownership or admitting a room the migration would then destroy. With it,
-- every in-flight legacy writer settles before the checks run, and no old instance can claim,
-- admit or write until this transaction commits — at which point the drops below have already
-- made the legacy machinery impossible. The subsequent ALTERs/DROPs need the same mode, so the
-- lock is held exactly once and never upgraded across a wait.
LOCK TABLE "release_control", "release_versions", "rooms", "match_tickets" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- The guard runs second, now race-free: an unsafe legacy database aborts the whole migration
-- transaction before any DDL touches it — user data (accounts, sessions, results, finished
-- rooms) is preserved unconditionally. Refusal conditions are exactly the "legacy cutover with
-- live work" cases: matches still being played, seat reservations still inside their
-- TTL, results still unsettled, and runtime leases still held by an old release-scoped runtime.
-- A lapsed-but-unreleased lease heals itself on the database clock (30s lease), so the operator
-- only ever has to stop the old containers and wait out the TTL.
DO $$
DECLARE
	blocking integer;
BEGIN
	IF to_regclass('public.release_versions') IS NOT NULL THEN
		SELECT count(*) INTO blocking FROM "rooms"
			WHERE "phase" in ('generating', 'countdown', 'playing');
		IF blocking > 0 THEN
			RAISE EXCEPTION '迁移中止：仍有 % 场进行中的对局，请先用旧版本工具完成排水并停止旧实例后再迁移', blocking;
		END IF;

		SELECT count(*) INTO blocking FROM "rooms"
			WHERE "reservation_state" = 'reserved' AND "reservation_expires_at" is not null
				AND "reservation_expires_at" > floor(extract(epoch from clock_timestamp()) * 1000);
		IF blocking > 0 THEN
			RAISE EXCEPTION '迁移中止：仍有 % 个未过期的预约席位，请等待其过期后再迁移', blocking;
		END IF;

		SELECT count(*) INTO blocking FROM "rooms"
			WHERE "persistence" in ('saving', 'error');
		IF blocking > 0 THEN
			RAISE EXCEPTION '迁移中止：仍有 % 间房间的战绩未落定，请先恢复结果写入后再迁移', blocking;
		END IF;

		SELECT count(*) INTO blocking FROM "release_versions"
			WHERE "runtime_id" is not null AND "lease_until" is not null
				AND "lease_until" > floor(extract(epoch from clock_timestamp()) * 1000);
		IF blocking > 0 THEN
			RAISE EXCEPTION '迁移中止：仍有 % 个存活的旧运行时租约，请先停止旧实例并等待租约到期后再迁移', blocking;
		END IF;
	END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "runtime_control" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	"runtime_id" text,
	"runtime_epoch" integer DEFAULT 0 NOT NULL,
	"lease_until" bigint,
	CONSTRAINT "runtime_control_singleton" CHECK ("runtime_control"."singleton" = 1),
	CONSTRAINT "runtime_control_mode" CHECK ("runtime_control"."mode" in ('open','draining'))
);
--> statement-breakpoint
-- Seed the singleton. A fresh, empty install starts `open` (development convenience); a legacy
-- cutover — any prior release machinery or user data — starts `draining` and stays that way until
-- the deployment's own explicit resume. Startup never resets this row.
INSERT INTO "runtime_control" ("singleton", "mode", "revision", "updated_at")
SELECT 1,
	CASE
		WHEN EXISTS (SELECT 1 FROM "release_versions") OR EXISTS (SELECT 1 FROM "accounts")
			THEN 'draining'
		ELSE 'open'
	END,
	0,
	floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
--> statement-breakpoint
-- Queue intents are not user data; leaving them would permanently block the drain barrier.
DELETE FROM "match_tickets" WHERE "state" = 'waiting';--> statement-breakpoint
-- Management is WeChat-session-role based (no admin tokens): every account is a `user` by
-- default, and the operator-designated identity below is promoted once here. Later logins
-- preserve the role — nothing in the login path ever resets it.
ALTER TABLE "accounts" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_role" CHECK ("accounts"."role" in ('user','admin'));--> statement-breakpoint
UPDATE "accounts" SET "role" = 'admin' WHERE "wechat_identity" = 'union:omBLS6xCiew0470A53hBYx0mzCbw';--> statement-breakpoint
DROP INDEX "rooms_release_id_idx";--> statement-breakpoint
DROP INDEX "match_tickets_release_state_idx";--> statement-breakpoint
CREATE INDEX "match_tickets_state_idx" ON "match_tickets" USING btree ("state");--> statement-breakpoint
ALTER TABLE "match_tickets" DROP CONSTRAINT "match_tickets_release_id_release_versions_id_fk";--> statement-breakpoint
ALTER TABLE "match_tickets" DROP COLUMN "release_id";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_release_id_release_versions_id_fk";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "release_id";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "draining";--> statement-breakpoint
DROP TABLE "release_control";--> statement-breakpoint
DROP TABLE "release_versions";
