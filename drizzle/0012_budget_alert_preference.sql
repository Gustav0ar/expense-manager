CREATE TABLE "budget_alert_preference" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alert_preference_locale_check" CHECK ("locale" in ('en', 'pt-BR'))
);
--> statement-breakpoint
ALTER TABLE "budget_alert_preference" ADD CONSTRAINT "budget_alert_preference_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_alert_preference" ADD CONSTRAINT "budget_alert_preference_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "budget_alert_preference_enabled_idx" ON "budget_alert_preference" USING btree ("workspace_id") WHERE "is_enabled" = true;
