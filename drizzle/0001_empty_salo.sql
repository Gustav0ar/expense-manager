CREATE TABLE "category_budget" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"period_month" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"warning_threshold_pct" integer DEFAULT 80 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_budget_amount_cents_check" CHECK ("category_budget"."amount_cents" > 0),
	CONSTRAINT "category_budget_warning_threshold_check" CHECK ("category_budget"."warning_threshold_pct" between 1 and 100),
	CONSTRAINT "category_budget_period_month_check" CHECK (extract(day from "category_budget"."period_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "expense_attachment" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"expense_id" bigint NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_attachment_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "expense_attachment_size_bytes_check" CHECK ("expense_attachment"."size_bytes" between 1 and 5242880)
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"source_type" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_source_type_check" CHECK ("import_batch"."source_type" in ('csv', 'ofx'))
);
--> statement-breakpoint
CREATE TABLE "mfa_session" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_expense" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"created_by_user_id" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'BRL' NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"next_run_date" date NOT NULL,
	"end_date" date,
	"payment_method" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_expense_amount_cents_check" CHECK ("recurring_expense"."amount_cents" > 0),
	CONSTRAINT "recurring_expense_frequency_check" CHECK ("recurring_expense"."frequency" in ('weekly', 'monthly', 'yearly')),
	CONSTRAINT "recurring_expense_interval_count_check" CHECK ("recurring_expense"."interval_count" between 1 and 24),
	CONSTRAINT "recurring_expense_status_check" CHECK ("recurring_expense"."status" in ('active', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "user_mfa_config" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted_secret" text NOT NULL,
	"recovery_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "source_recurring_expense_id" bigint;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "import_batch_id" bigint;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "installment_group_id" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "installment_number" integer;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "installments_total" integer;--> statement-breakpoint
ALTER TABLE "category_budget" ADD CONSTRAINT "category_budget_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_budget" ADD CONSTRAINT "category_budget_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_budget" ADD CONSTRAINT "category_budget_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_session" ADD CONSTRAINT "mfa_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_session" ADD CONSTRAINT "mfa_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_config" ADD CONSTRAINT "user_mfa_config_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_budget_workspace_category_month_unique_idx" ON "category_budget" USING btree ("workspace_id","category_id","period_month");--> statement-breakpoint
CREATE INDEX "category_budget_workspace_month_idx" ON "category_budget" USING btree ("workspace_id","period_month");--> statement-breakpoint
CREATE INDEX "category_budget_category_idx" ON "category_budget" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "category_budget_created_by_idx" ON "category_budget" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "expense_attachment_workspace_expense_idx" ON "expense_attachment" USING btree ("workspace_id","expense_id");--> statement-breakpoint
CREATE INDEX "expense_attachment_expense_idx" ON "expense_attachment" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_attachment_uploaded_by_idx" ON "expense_attachment" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "import_batch_workspace_created_idx" ON "import_batch" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "import_batch_uploaded_by_idx" ON "import_batch" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_session_user_session_unique_idx" ON "mfa_session" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "mfa_session_session_idx" ON "mfa_session" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mfa_session_expires_at_idx" ON "mfa_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "recurring_expense_workspace_next_run_idx" ON "recurring_expense" USING btree ("workspace_id","next_run_date") WHERE "recurring_expense"."status" = 'active';--> statement-breakpoint
CREATE INDEX "recurring_expense_workspace_idx" ON "recurring_expense" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "recurring_expense_category_idx" ON "recurring_expense" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "recurring_expense_created_by_idx" ON "recurring_expense" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_source_recurring_expense_id_recurring_expense_id_fk" FOREIGN KEY ("source_recurring_expense_id") REFERENCES "public"."recurring_expense"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_workspace_date_unique_idx" ON "expense" USING btree ("workspace_id","source_recurring_expense_id","expense_date") WHERE "expense"."source_recurring_expense_id" is not null and "expense"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expense_import_batch_idx" ON "expense" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "expense_installment_group_idx" ON "expense" USING btree ("workspace_id","installment_group_id");--> statement-breakpoint
CREATE INDEX "expense_source_recurring_idx" ON "expense" USING btree ("source_recurring_expense_id");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_installment_numbers_check" CHECK (("expense"."installment_number" is null and "expense"."installments_total" is null) or ("expense"."installment_number" between 1 and "expense"."installments_total" and "expense"."installments_total" between 2 and 120));