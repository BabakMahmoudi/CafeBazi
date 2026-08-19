CREATE TABLE "auth_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_credentials_user_id_unique" ON "auth_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_credentials_username_unique" ON "auth_credentials" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_username_lower_unique" ON "users" USING btree (lower("telegram_username"));