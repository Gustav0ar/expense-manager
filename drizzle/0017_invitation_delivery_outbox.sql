CREATE TABLE "workspace_invitation_delivery" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invitation_id" bigint NOT NULL,
	"encrypted_token" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_category" text,
	"provider" text,
	"provider_message_id" text,
	"provider_message_uuid" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitation_delivery_status_check" CHECK ("workspace_invitation_delivery"."status" in ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "workspace_invitation_delivery_attempt_count_check" CHECK ("workspace_invitation_delivery"."attempt_count" >= 0),
	CONSTRAINT "workspace_invitation_delivery_error_category_check" CHECK ("workspace_invitation_delivery"."last_error_category" is null or "workspace_invitation_delivery"."last_error_category" in ('timeout', 'configuration', 'provider_rejected', 'provider_unavailable', 'network', 'encryption', 'expired', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "workspace_invitation_delivery" ADD CONSTRAINT "workspace_invitation_delivery_invitation_id_workspace_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."workspace_invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitation_delivery_invitation_unique_idx" ON "workspace_invitation_delivery" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "workspace_invitation_delivery_status_created_idx" ON "workspace_invitation_delivery" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "workspace_invitation_delivery_claim_expires_at_idx" ON "workspace_invitation_delivery" USING btree ("claim_expires_at") WHERE "workspace_invitation_delivery"."status" = 'sending';