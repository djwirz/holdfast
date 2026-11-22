CREATE TYPE "public"."auction_status" AS ENUM('scheduled', 'open', 'closed', 'settled');--> statement-breakpoint
CREATE TYPE "public"."bid_status" AS ENUM('pending', 'accepted', 'outbid', 'lost_race', 'rejected', 'won');--> statement-breakpoint
CREATE TYPE "public"."outbox_kind" AS ENUM('cancel_hold', 'capture', 'publish');--> statement-breakpoint
CREATE TABLE "auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "auction_status" DEFAULT 'scheduled' NOT NULL,
	"starting_price" integer NOT NULL,
	"min_increment" integer NOT NULL,
	"current_high_bid_id" uuid,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auctions_ends_after_starts" CHECK ("auctions"."ends_at" > "auctions"."starts_at"),
	CONSTRAINT "auctions_at_most_one_day" CHECK ("auctions"."ends_at" - "auctions"."starts_at" <= interval '1 day'),
	CONSTRAINT "auctions_starting_price_positive" CHECK ("auctions"."starting_price" > 0),
	CONSTRAINT "auctions_min_increment_positive" CHECK ("auctions"."min_increment" > 0),
	CONSTRAINT "auctions_title_not_blank" CHECK (length(btrim("auctions"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount" integer NOT NULL,
	"status" "bid_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"payment_intent_id" text,
	"auction_version" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "bids_amount_positive" CHECK ("bids"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "outbox_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"stripe_customer_id" text,
	"default_payment_method_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_current_high_bid_id_bids_id_fk" FOREIGN KEY ("current_high_bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auctions_status_ends_at" ON "auctions" USING btree ("status","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_user_idempotency_key" ON "bids" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_payment_intent_id" ON "bids" USING btree ("payment_intent_id") WHERE "bids"."payment_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bids_auction_version" ON "bids" USING btree ("auction_id","auction_version") WHERE "bids"."auction_version" is not null;--> statement-breakpoint
CREATE INDEX "bids_status_created_at" ON "bids" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("available_at") WHERE "outbox"."done_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_expires_at" ON "sessions" USING btree ("expires_at");