CREATE TABLE "budget_alert_recipient" (
	"workspace_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alert_recipient_workspace_user_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
DROP INDEX "budget_alert_delivery_workspace_month_recipient_unique_idx";--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "recipient_label_snapshot" text;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "category_id" bigint;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "category_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "last_error_category" text;--> statement-breakpoint
ALTER TABLE "budget_alert_preference" ADD COLUMN "recipient_mode" text DEFAULT 'all_managers' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_alert_preference" ADD COLUMN "escalate_over_budget" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_alert_recipient" ADD CONSTRAINT "budget_alert_recipient_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alert_recipient" ADD CONSTRAINT "budget_alert_recipient_workspace_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_member"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alert_recipient_user_idx" ON "budget_alert_recipient" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_alert_recipient_created_by_idx" ON "budget_alert_recipient" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_delivery_alert_recipient_unique_idx" ON "budget_alert_delivery" USING btree ("workspace_id","category_id","period_month","recipient_user_id","level","stage") WHERE "budget_alert_delivery"."recipient_user_id" is not null and "budget_alert_delivery"."category_id" is not null and "budget_alert_delivery"."level" is not null and "budget_alert_delivery"."stage" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_delivery_transition_recipient_unique_idx" ON "budget_alert_delivery" USING btree ("workspace_id","period_month","category_id","recipient_user_id","stage") WHERE "budget_alert_delivery"."recipient_user_id" is not null and "budget_alert_delivery"."category_id" is not null and "budget_alert_delivery"."level" is not null and "budget_alert_delivery"."stage" is not null;--> statement-breakpoint
CREATE INDEX "budget_alert_delivery_workspace_history_idx" ON "budget_alert_delivery" USING btree ("workspace_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "budget_alert_delivery_recipient_user_idx" ON "budget_alert_delivery" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "budget_alert_delivery_category_idx" ON "budget_alert_delivery" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_delivery_workspace_month_recipient_unique_idx" ON "budget_alert_delivery" USING btree ("workspace_id","period_month",lower("recipient_email")) WHERE "budget_alert_delivery"."recipient_user_id" is null and "budget_alert_delivery"."category_id" is null and "budget_alert_delivery"."level" is null and "budget_alert_delivery"."stage" is null;--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_level_check" CHECK ("budget_alert_delivery"."level" is null or "budget_alert_delivery"."level" in ('warning', 'over'));--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_stage_check" CHECK ("budget_alert_delivery"."stage" is null or "budget_alert_delivery"."stage" in ('initial', 'escalation'));--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_escalation_level_check" CHECK ("budget_alert_delivery"."stage" is null or "budget_alert_delivery"."stage" <> 'escalation' or "budget_alert_delivery"."level" = 'over');--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_error_category_check" CHECK ("budget_alert_delivery"."last_error_category" is null or "budget_alert_delivery"."last_error_category" in ('timeout', 'configuration', 'provider_rejected', 'provider_unavailable', 'network', 'unknown'));--> statement-breakpoint
ALTER TABLE "budget_alert_preference" ADD CONSTRAINT "budget_alert_preference_recipient_mode_check" CHECK ("budget_alert_preference"."recipient_mode" in ('all_managers', 'selected'));