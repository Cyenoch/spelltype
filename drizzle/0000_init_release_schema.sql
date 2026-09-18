CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"username_key" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "accounts_username_key_unique" UNIQUE("username_key")
);
--> statement-breakpoint
CREATE TABLE "departures" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"match_id" text,
	"departed_at" bigint NOT NULL,
	CONSTRAINT "departures_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "match_tickets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"release_id" text NOT NULL,
	"username" text NOT NULL,
	"state" text NOT NULL,
	"room_id" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "match_tickets_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "match_tickets_state" CHECK ("match_tickets"."state" in ('waiting','matched'))
);
--> statement-breakpoint
CREATE TABLE "players" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"slot" integer NOT NULL,
	"joined_at" bigint NOT NULL,
	"slot_expires_at" bigint,
	"conn_id" text,
	"seated" integer DEFAULT 0 NOT NULL,
	"ready" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"spell_index" integer DEFAULT 0 NOT NULL,
	"spells_cast" integer DEFAULT 0 NOT NULL,
	"hp" integer DEFAULT 2400 NOT NULL,
	"max_hp" integer DEFAULT 2400 NOT NULL,
	"damage_dealt" integer DEFAULT 0 NOT NULL,
	"correct_chars" integer DEFAULT 0 NOT NULL,
	"attempt_total" integer DEFAULT 0 NOT NULL,
	"error_total" integer DEFAULT 0 NOT NULL,
	"cpm" integer DEFAULT 0 NOT NULL,
	"last_input" text DEFAULT '' NOT NULL,
	"eliminated_at" bigint,
	CONSTRAINT "players_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "release_control" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"active_release_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "release_control_singleton" CHECK ("release_control"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE "release_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"operation_id" text NOT NULL,
	"admission_epoch" integer DEFAULT 0 NOT NULL,
	"runtime_id" text,
	"runtime_epoch" integer DEFAULT 0 NOT NULL,
	"lease_until" bigint,
	"checked_epoch" integer,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"retired_at" bigint,
	CONSTRAINT "release_versions_id_hex" CHECK ("release_versions"."id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "release_versions_state" CHECK ("release_versions"."state" in ('staged','active','retiring','retired'))
);
--> statement-breakpoint
CREATE TABLE "results" (
	"match_id" text NOT NULL,
	"user_id" text NOT NULL,
	"room_id" text NOT NULL,
	"theme" text NOT NULL,
	"damage_dealt" integer NOT NULL,
	"hp_remaining" integer NOT NULL,
	"spells_cast" integer NOT NULL,
	"correct_chars" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"rank" integer NOT NULL,
	"cpm" integer NOT NULL,
	"accuracy" real,
	"created_at" bigint NOT NULL,
	CONSTRAINT "results_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_sessions" (
	"session_hash" text NOT NULL,
	"room_id" text NOT NULL,
	CONSTRAINT "room_sessions_session_hash_room_id_pk" PRIMARY KEY("session_hash","room_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"host_id" text NOT NULL,
	"mode" text NOT NULL,
	"theme" text NOT NULL,
	"difficulty" text NOT NULL,
	"phase" text NOT NULL,
	"deadline" bigint DEFAULT 0 NOT NULL,
	"started_at" bigint,
	"ended_at" bigint,
	"end_reason" text,
	"match_id" text,
	"spell_book" text,
	"events_json" text DEFAULT '[]' NOT NULL,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"error" text,
	"generation_token" text,
	"generation_claim" text,
	"generation_seq" integer DEFAULT 0 NOT NULL,
	"reservation_state" text DEFAULT 'none' NOT NULL,
	"reservation_expires_at" bigint,
	"locked" integer DEFAULT 0 NOT NULL,
	"persistence" text DEFAULT 'idle' NOT NULL,
	"persist_attempts" integer DEFAULT 0 NOT NULL,
	"persist_retry_at" bigint,
	"next_alarm_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "rooms_id_hex" CHECK ("rooms"."id" ~ '^[0-9a-f]{24}$'),
	CONSTRAINT "rooms_mode" CHECK ("rooms"."mode" in ('private','quick')),
	CONSTRAINT "rooms_difficulty" CHECK ("rooms"."difficulty" = 'hard'),
	CONSTRAINT "rooms_phase" CHECK ("rooms"."phase" in ('lobby','generating','countdown','playing','finished')),
	CONSTRAINT "rooms_end_reason" CHECK ("rooms"."end_reason" is null or "rooms"."end_reason" in ('elimination','timeout')),
	CONSTRAINT "rooms_reservation_state" CHECK ("rooms"."reservation_state" in ('none','reserved','cancelled','expired','locked')),
	CONSTRAINT "rooms_persistence" CHECK ("rooms"."persistence" in ('idle','saving','saved','error'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departures" ADD CONSTRAINT "departures_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_tickets" ADD CONSTRAINT "match_tickets_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_tickets" ADD CONSTRAINT "match_tickets_release_id_release_versions_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_tickets" ADD CONSTRAINT "match_tickets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_control" ADD CONSTRAINT "release_control_active_release_id_release_versions_id_fk" FOREIGN KEY ("active_release_id") REFERENCES "public"."release_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_sessions" ADD CONSTRAINT "room_sessions_session_hash_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_sessions" ADD CONSTRAINT "room_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_release_id_release_versions_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_tickets_release_state_idx" ON "match_tickets" USING btree ("release_id","state");--> statement-breakpoint
CREATE INDEX "match_tickets_expires_at_idx" ON "match_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "players_room_slot_key" ON "players" USING btree ("room_id","slot");--> statement-breakpoint
CREATE INDEX "results_user_recent_idx" ON "results" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "room_sessions_room_id_idx" ON "room_sessions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "rooms_release_id_idx" ON "rooms" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "rooms_next_alarm_idx" ON "rooms" USING btree ("next_alarm_at") WHERE "rooms"."next_alarm_at" is not null;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");