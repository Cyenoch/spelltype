ALTER TABLE "accounts" ADD COLUMN "banned_at" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ban_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ban_expiry" CHECK (not ("accounts"."banned_at" is null and "accounts"."ban_expires_at" is not null));