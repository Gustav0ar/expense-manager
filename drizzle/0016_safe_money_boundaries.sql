ALTER TABLE "category_budget" DROP CONSTRAINT "category_budget_amount_cents_check";--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_amount_cents_check";--> statement-breakpoint
ALTER TABLE "recurring_expense" DROP CONSTRAINT "recurring_expense_amount_cents_check";--> statement-breakpoint
ALTER TABLE "category_budget" ADD CONSTRAINT "category_budget_amount_cents_check" CHECK ("category_budget"."amount_cents" > 0 and "category_budget"."amount_cents" <= 100000000000) NOT VALID;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_amount_cents_check" CHECK ("expense"."amount_cents" > 0 and "expense"."amount_cents" <= 100000000000) NOT VALID;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_amount_cents_check" CHECK ("recurring_expense"."amount_cents" > 0 and "recurring_expense"."amount_cents" <= 100000000000) NOT VALID;--> statement-breakpoint
ALTER TABLE "category_budget" VALIDATE CONSTRAINT "category_budget_amount_cents_check";--> statement-breakpoint
ALTER TABLE "expense" VALIDATE CONSTRAINT "expense_amount_cents_check";--> statement-breakpoint
ALTER TABLE "recurring_expense" VALIDATE CONSTRAINT "recurring_expense_amount_cents_check";
