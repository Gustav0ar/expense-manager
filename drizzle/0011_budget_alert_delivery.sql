CREATE TABLE "budget_alert_delivery" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"period_month" date NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alert_delivery_status_check" CHECK ("status" in ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "budget_alert_delivery_attempt_count_check" CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD CONSTRAINT "budget_alert_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_delivery_workspace_month_recipient_unique_idx" ON "budget_alert_delivery" USING btree ("workspace_id", "period_month", lower("recipient_email"));
--> statement-breakpoint
CREATE INDEX "budget_alert_delivery_workspace_month_status_idx" ON "budget_alert_delivery" USING btree ("workspace_id", "period_month", "status");
--> statement-breakpoint
CREATE INDEX "budget_alert_delivery_claim_expires_at_idx" ON "budget_alert_delivery" USING btree ("claim_expires_at") WHERE "status" = 'sending';
