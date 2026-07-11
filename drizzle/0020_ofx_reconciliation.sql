CREATE TABLE "bank_transaction" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"source_account_fingerprint" char(64) NOT NULL,
	"source_identity" char(64) NOT NULL,
	"source_checksum" char(64) NOT NULL,
	"source_currency" char(3),
	"provider_transaction_id" text,
	"file_name" text NOT NULL,
	"posted_date" date NOT NULL,
	"signed_amount_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"memo" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expense_id" bigint,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transaction_amount_cents_check" CHECK ("bank_transaction"."signed_amount_cents" <> 0 and abs("bank_transaction"."signed_amount_cents") <= 100000000000),
	CONSTRAINT "bank_transaction_status_check" CHECK ("bank_transaction"."status" in ('pending', 'matched', 'created', 'ignored')),
	CONSTRAINT "bank_transaction_source_currency_check" CHECK ("bank_transaction"."source_currency" is null or "bank_transaction"."source_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_transaction_decision_check" CHECK (("bank_transaction"."status" = 'pending' and "bank_transaction"."expense_id" is null and "bank_transaction"."decided_at" is null) or ("bank_transaction"."status" = 'ignored' and "bank_transaction"."expense_id" is null and "bank_transaction"."decided_at" is not null) or ("bank_transaction"."status" in ('matched', 'created') and "bank_transaction"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transaction_workspace_source_unique_idx" ON "bank_transaction" USING btree ("workspace_id","source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transaction_expense_unique_idx" ON "bank_transaction" USING btree ("expense_id") WHERE "bank_transaction"."expense_id" is not null;--> statement-breakpoint
CREATE INDEX "bank_transaction_workspace_pending_idx" ON "bank_transaction" USING btree ("workspace_id","posted_date","id") WHERE "bank_transaction"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "bank_transaction_uploaded_by_idx" ON "bank_transaction" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "bank_transaction_decided_by_idx" ON "bank_transaction" USING btree ("decided_by_user_id");
