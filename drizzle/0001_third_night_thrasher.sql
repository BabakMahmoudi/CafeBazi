CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"nonce" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"source" text DEFAULT 'stellar' NOT NULL,
	"label" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_links" ADD CONSTRAINT "wallet_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenges_nonce_unique" ON "auth_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "auth_challenges_status_idx" ON "auth_challenges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "auth_challenges_public_key_idx" ON "auth_challenges" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_links_public_key_unique" ON "wallet_links" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "wallet_links_user_id_idx" ON "wallet_links" USING btree ("user_id");