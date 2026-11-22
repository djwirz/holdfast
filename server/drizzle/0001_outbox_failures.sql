DROP INDEX "outbox_due";--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("available_at") WHERE "outbox"."done_at" is null and "outbox"."failed_at" is null;