ALTER TABLE "workspace" ALTER COLUMN "currency" SET DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "expense" ALTER COLUMN "currency" SET DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "recurring_expense" ALTER COLUMN "currency" SET DEFAULT 'USD';
