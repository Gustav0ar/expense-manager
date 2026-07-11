CREATE TABLE "import_preview" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"source_type" text NOT NULL,
	"file_name" text NOT NULL,
	"source_checksum" char(64) NOT NULL,
	"row_count" integer NOT NULL,
	"analysis" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_batch_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "import_preview_source_type_check" CHECK ("import_preview"."source_type" in ('csv', 'ofx')),
	CONSTRAINT "import_preview_status_check" CHECK ("import_preview"."status" in ('pending', 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "import_baseline_hash" char(64);--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "duplicate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "undone_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "undo_skipped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "undone_by_user_id" text;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_confirmed_batch_id_import_batch_id_fk" FOREIGN KEY ("confirmed_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_preview_workspace_user_idx" ON "import_preview" USING btree ("workspace_id","uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "import_preview_expires_idx" ON "import_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "import_preview_confirmed_batch_idx" ON "import_preview" USING btree ("confirmed_batch_id");--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_undone_by_user_id_user_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_undone_by_idx" ON "import_batch" USING btree ("undone_by_user_id");