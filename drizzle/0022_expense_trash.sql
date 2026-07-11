ALTER TABLE "attachment_deletion" ADD COLUMN "reason" text DEFAULT 'attachment_deleted' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "trash_expires_at" timestamp with time zone;--> statement-breakpoint
-- Legacy soft-deleted rows are immediately expired and intentionally cannot be
-- restored: deployments before the durable attachment lifecycle may already
-- have removed their files.
UPDATE "expense"
SET "trash_expires_at" = "deleted_at"
WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
UPDATE "expense_attachment" a
SET "deleted_at" = COALESCE(a."deleted_at", e."deleted_at")
FROM "expense" e
WHERE e."id" = a."expense_id"
	AND e."workspace_id" = a."workspace_id"
	AND e."deleted_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "attachment_deletion" (
	"attachment_id", "workspace_id", "expense_id", "entity_type", "entity_id",
	"storage_key", "size_bytes", "sha256", "status", "reason", "not_before",
	"next_attempt_at", "created_at", "updated_at"
)
SELECT a."id", a."workspace_id", a."expense_id", 'expense_attachment', a."id"::text,
	a."storage_key", a."size_bytes", a."sha256", 'pending', 'attachment_deleted',
	e."deleted_at" + interval '48 hours', e."deleted_at" + interval '48 hours',
	e."deleted_at", e."deleted_at"
FROM "expense_attachment" a
JOIN "expense" e ON e."id" = a."expense_id" AND e."workspace_id" = a."workspace_id"
LEFT JOIN "attachment_deletion" d ON d."attachment_id" = a."id"
WHERE e."deleted_at" IS NOT NULL AND d."id" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE INDEX "expense_workspace_trash_idx" ON "expense" USING btree ("workspace_id","deleted_at","id") WHERE "expense"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "expense_trash_expiry_idx" ON "expense" USING btree ("trash_expires_at","id") WHERE "expense"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "attachment_deletion" ADD CONSTRAINT "attachment_deletion_reason_check" CHECK ("attachment_deletion"."reason" in ('attachment_deleted', 'expense_trash'));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_trash_timestamp_pair_check" CHECK (("expense"."deleted_at" is null and "expense"."trash_expires_at" is null) or ("expense"."deleted_at" is not null and "expense"."trash_expires_at" is not null));
