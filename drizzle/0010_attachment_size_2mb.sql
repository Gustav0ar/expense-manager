ALTER TABLE "expense_attachment" DROP CONSTRAINT IF EXISTS "expense_attachment_size_bytes_check";--> statement-breakpoint
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_size_bytes_check" CHECK ("size_bytes" between 1 and 2097152) NOT VALID;
