ALTER TABLE "budget_alert_delivery" ADD COLUMN "provider_reference" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "provider" text;
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "provider_message_id" text;
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "provider_message_uuid" text;
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "last_provider_event" text;
--> statement-breakpoint
ALTER TABLE "budget_alert_delivery" ADD COLUMN "last_provider_event_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_delivery_provider_reference_unique_idx" ON "budget_alert_delivery" USING btree ("provider_reference");
--> statement-breakpoint
CREATE TABLE "email_delivery_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"event_type" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"budget_alert_delivery_id" bigint,
	"provider_message_id" text,
	"provider_message_uuid" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_delivery_event_provider_check" CHECK ("provider" in ('mailjet')),
	CONSTRAINT "email_delivery_event_type_check" CHECK ("event_type" in ('sent', 'open', 'click', 'bounce', 'spam', 'blocked', 'unsub'))
);
--> statement-breakpoint
ALTER TABLE "email_delivery_event" ADD CONSTRAINT "email_delivery_event_budget_alert_delivery_fk" FOREIGN KEY ("budget_alert_delivery_id") REFERENCES "public"."budget_alert_delivery"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_event_provider_fingerprint_unique_idx" ON "email_delivery_event" USING btree ("provider", "fingerprint");
--> statement-breakpoint
CREATE INDEX "email_delivery_event_type_time_idx" ON "email_delivery_event" USING btree ("event_type", "event_time");
--> statement-breakpoint
CREATE INDEX "email_delivery_event_budget_alert_delivery_idx" ON "email_delivery_event" USING btree ("budget_alert_delivery_id");
