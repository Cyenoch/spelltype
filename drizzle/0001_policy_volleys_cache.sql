-- Enter through the runtime lease table before changing room storage. Acquiring
-- players first and rooms later reverses live transactions and can deadlock.
LOCK TABLE "release_versions", "rooms", "players", "results" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "combat_volleys" (
	"room_id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"ends_at" bigint NOT NULL,
	"roster" jsonb NOT NULL,
	"casts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spell_book_cache" (
	"theme" text PRIMARY KEY NOT NULL,
	"book" jsonb,
	"published_at" bigint,
	"token" text,
	"lease_expires_at" bigint
);
--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "hp" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "hp" SET DEFAULT 2400;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "damage_dealt" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "results" ALTER COLUMN "damage_dealt" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "results" ALTER COLUMN "hp_remaining" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_opened_at" bigint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_not_before" bigint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "draft_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_reset_reason" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_sampled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_gate_hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_recoveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_min_completion_ratio" double precision;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_overloads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_recovered_completions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "input_recovery_departures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_policy_version" text DEFAULT 'legacy-unmeasured' NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_policy_mode" text;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_gate_hits" integer;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_recoveries" integer;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_overloads" integer;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_recovered_completions" integer;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_recovery_departures" integer;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "input_min_completion_ratio" double precision;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "input_policy_version" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "input_policy_mode" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "input_min_ms_per_code_point" integer;--> statement-breakpoint
ALTER TABLE "combat_volleys" ADD CONSTRAINT "combat_volleys_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;