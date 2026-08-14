CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"shop_id" text,
	"amount" numeric(30, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coffee_shops" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"contact_user_id" text NOT NULL,
	"source" text DEFAULT 'username' NOT NULL,
	"nickname" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_session_id" text NOT NULL,
	"score" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game" text NOT NULL,
	"nonce" text NOT NULL,
	"hmac" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"quantity_grams" numeric(30, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lottery_draws" (
	"id" text PRIMARY KEY NOT NULL,
	"week" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"winner_user_id" text,
	"ledger_hash" text,
	"prize" numeric(30, 0) DEFAULT '100' NOT NULL,
	"drawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lottery_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"draw_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tickets" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" text NOT NULL,
	"amount_tak" numeric(30, 0) NOT NULL,
	"beans_grams" numeric(30, 0) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stellar_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric(30, 0) NOT NULL,
	"from_account" text,
	"to_account" text,
	"memo" text,
	"user_id" text,
	"shop_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"telegram_id" text NOT NULL,
	"telegram_username" text,
	"first_name" text NOT NULL,
	"phone" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_shop_id_coffee_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."coffee_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_shops" ADD CONSTRAINT "coffee_shops_merchant_id_users_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_contact_user_id_users_id_fk" FOREIGN KEY ("contact_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_scores" ADD CONSTRAINT "game_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_scores" ADD CONSTRAINT "game_scores_game_session_id_game_sessions_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lottery_entries" ADD CONSTRAINT "lottery_entries_draw_id_lottery_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."lottery_draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lottery_entries" ADD CONSTRAINT "lottery_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_shop_id_coffee_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."coffee_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stellar_accounts" ADD CONSTRAINT "stellar_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_shop_id_coffee_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."coffee_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "balances_user_id_unique" ON "balances" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "balances_shop_id_unique" ON "balances" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_shops_slug_unique" ON "coffee_shops" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "coffee_shops_merchant_id_idx" ON "coffee_shops" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "coffee_shops_is_active_idx" ON "coffee_shops" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_contact_unique" ON "contacts" USING btree ("user_id","contact_user_id");--> statement-breakpoint
CREATE INDEX "contacts_user_last_used_idx" ON "contacts" USING btree ("user_id","last_used_at");--> statement-breakpoint
CREATE INDEX "game_scores_user_id_idx" ON "game_scores" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_scores_session_unique" ON "game_scores" USING btree ("game_session_id");--> statement-breakpoint
CREATE INDEX "game_sessions_user_game_created_idx" ON "game_sessions" USING btree ("user_id","game","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lottery_draws_week_unique" ON "lottery_draws" USING btree ("week");--> statement-breakpoint
CREATE UNIQUE INDEX "lottery_entries_draw_user_unique" ON "lottery_entries" USING btree ("draw_id","user_id");--> statement-breakpoint
CREATE INDEX "lottery_entries_draw_id_idx" ON "lottery_entries" USING btree ("draw_id");--> statement-breakpoint
CREATE INDEX "redemptions_shop_id_idx" ON "redemptions" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stellar_accounts_public_key_unique" ON "stellar_accounts" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "stellar_accounts_user_id_idx" ON "stellar_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tx_hash_unique" ON "transactions" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "transactions_user_created_idx" ON "transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_id_unique" ON "users" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX "users_telegram_username_idx" ON "users" USING btree ("telegram_username");