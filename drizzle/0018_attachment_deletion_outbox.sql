CREATE TABLE "attachment_deletion" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"attachment_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"expense_id" bigint NOT NULL,
	"entity_type" text DEFAULT 'expense_attachment' NOT NULL,
	"entity_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"last_error_category" text,
	"last_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_deletion_status_check" CHECK ("attachment_deletion"."status" in ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "attachment_deletion_attempt_count_check" CHECK ("attachment_deletion"."attempt_count" >= 0),
	CONSTRAINT "attachment_deletion_size_bytes_check" CHECK ("attachment_deletion"."size_bytes" between 1 and 2097152),
	CONSTRAINT "attachment_deletion_error_category_check" CHECK ("attachment_deletion"."last_error_category" is null or "attachment_deletion"."last_error_category" in ('permission', 'io', 'path_invalid', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "expense_attachment" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_deletion_attachment_unique_idx" ON "attachment_deletion" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_deletion_storage_key_unique_idx" ON "attachment_deletion" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "attachment_deletion_due_idx" ON "attachment_deletion" USING btree ("status","next_attempt_at","id") WHERE "attachment_deletion"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "attachment_deletion_workspace_idx" ON "attachment_deletion" USING btree ("workspace_id");
--> statement-breakpoint
CREATE FUNCTION "enqueue_attachment_deletion_on_hard_delete"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO "attachment_deletion" (
		"attachment_id", "workspace_id", "expense_id", "entity_type", "entity_id",
		"storage_key", "size_bytes", "sha256", "status", "not_before",
		"next_attempt_at", "created_at", "updated_at"
	) VALUES (
		OLD."id", OLD."workspace_id", OLD."expense_id", 'expense_attachment', OLD."id"::text,
		OLD."storage_key", OLD."size_bytes", OLD."sha256", 'pending',
		now() + interval '48 hours', now() + interval '48 hours', now(), now()
	)
	ON CONFLICT ("attachment_id") DO NOTHING;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expense_attachment_enqueue_deletion_trigger"
BEFORE DELETE ON "expense_attachment"
FOR EACH ROW EXECUTE FUNCTION "enqueue_attachment_deletion_on_hard_delete"();
