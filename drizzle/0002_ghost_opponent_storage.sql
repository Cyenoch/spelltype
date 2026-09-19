CREATE TABLE "ghost_casts" (
	"room_id" text NOT NULL,
	"match_id" text NOT NULL,
	"user_id" text NOT NULL,
	"spell_index" integer NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "ghost_casts_match_id_user_id_spell_index_pk" PRIMARY KEY("match_id","user_id","spell_index")
);
--> statement-breakpoint
CREATE TABLE "ghosts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_user_id" text NOT NULL,
	"theme" text NOT NULL,
	"book" jsonb NOT NULL,
	"casts" jsonb NOT NULL,
	"rules_version" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_end_reason";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "role" SET DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "opponent_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "opponent_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "ghost_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "opponent_next_at" bigint;--> statement-breakpoint
ALTER TABLE "ghost_casts" ADD CONSTRAINT "ghost_casts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ghosts" ADD CONSTRAINT "ghosts_source_user_id_accounts_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ghost_casts_room_idx" ON "ghost_casts" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "ghosts_source_idx" ON "ghosts" USING btree ("source_user_id");--> statement-breakpoint
CREATE INDEX "ghosts_selection_idx" ON "ghosts" USING btree ("rules_version","created_at");--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_opponent_kind" CHECK ("results"."opponent_kind" in ('human','ghost','bot'));--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_opponent_kind" CHECK ("rooms"."opponent_kind" in ('human','ghost','bot'));--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_end_reason" CHECK ("rooms"."end_reason" is null or "rooms"."end_reason" in ('elimination','timeout','bot_concession','inactivity'));