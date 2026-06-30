CREATE TABLE "category_rule" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"match_target" text DEFAULT 'description' NOT NULL,
	"pattern" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_rule_target_check" CHECK ("category_rule"."match_target" in ('description', 'vendor', 'payment')),
	CONSTRAINT "category_rule_priority_check" CHECK ("category_rule"."priority" between 1 and 1000)
);
--> statement-breakpoint
DROP INDEX "expense_workspace_posted_date_idx";--> statement-breakpoint
DROP INDEX "expense_workspace_posted_category_date_idx";--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "cost_center" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "competency_month" date;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "review_status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "reviewed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "review_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "payment_status" text DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "paid_at" date;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "reconciled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_rule_workspace_name_unique_idx" ON "category_rule" USING btree ("workspace_id",lower("name")) WHERE "category_rule"."is_active" = true;--> statement-breakpoint
CREATE INDEX "category_rule_workspace_active_priority_idx" ON "category_rule" USING btree ("workspace_id","priority","id") WHERE "category_rule"."is_active" = true;--> statement-breakpoint
CREATE INDEX "category_rule_category_idx" ON "category_rule" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "category_rule_created_by_idx" ON "category_rule" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_reconciled_by_user_id_user_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_workspace_review_status_idx" ON "expense" USING btree ("workspace_id","review_status","expense_date") WHERE "expense"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expense_workspace_payment_status_idx" ON "expense" USING btree ("workspace_id","payment_status","expense_date") WHERE "expense"."deleted_at" is null and "expense"."review_status" = 'approved';--> statement-breakpoint
CREATE INDEX "expense_workspace_competency_idx" ON "expense" USING btree ("workspace_id","competency_month","expense_date") WHERE "expense"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expense_reviewed_by_idx" ON "expense" USING btree ("reviewed_by_user_id");--> statement-breakpoint
CREATE INDEX "expense_reconciled_by_idx" ON "expense" USING btree ("reconciled_by_user_id");--> statement-breakpoint
CREATE INDEX "expense_workspace_posted_date_idx" ON "expense" USING btree ("workspace_id","expense_date","id") WHERE "expense"."deleted_at" is null and "expense"."status" = 'posted' and "expense"."review_status" = 'approved';--> statement-breakpoint
CREATE INDEX "expense_workspace_posted_category_date_idx" ON "expense" USING btree ("workspace_id","category_id","expense_date") WHERE "expense"."deleted_at" is null and "expense"."status" = 'posted' and "expense"."review_status" = 'approved';--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_review_status_check" CHECK ("expense"."review_status" in ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payment_status_check" CHECK ("expense"."payment_status" in ('unpaid', 'paid', 'reconciled'));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_paid_at_check" CHECK (("expense"."payment_status" = 'unpaid' and "expense"."paid_at" is null) or ("expense"."payment_status" in ('paid', 'reconciled') and "expense"."paid_at" is not null));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_competency_month_check" CHECK ("expense"."competency_month" is null or extract(day from "expense"."competency_month") = 1);