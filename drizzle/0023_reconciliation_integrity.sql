-- Repair links that earlier generic expense mutations could leave decided
-- against an expense state that is no longer eligible for reconciliation.
INSERT INTO audit_event (
	workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at
)
SELECT
	b.workspace_id,
	NULL,
	'bank_transaction.reversed',
	'bank_transaction',
	b.id::text,
	jsonb_build_object(
		'expenseId', b.expense_id,
		'previousStatus', b.status,
		'reason', 'integrity_repair'
	),
	now()
FROM bank_transaction b
LEFT JOIN expense e ON e.id = b.expense_id
WHERE b.status IN ('matched', 'created')
	AND b.expense_id IS NOT NULL
	AND (
		e.id IS NULL
		OR b.workspace_id <> e.workspace_id
		OR b.signed_amount_cents >= 0
		OR e.deleted_at IS NOT NULL
		OR e.status <> 'posted'
		OR e.review_status <> 'approved'
		OR e.payment_status <> 'reconciled'
		OR e.amount_cents <> -b.signed_amount_cents
		OR abs(e.expense_date - b.posted_date) > 3
		OR (b.source_currency IS NOT NULL AND b.source_currency <> e.currency)
	);
--> statement-breakpoint
UPDATE expense e
SET
	payment_status = CASE
		WHEN e.status = 'posted' AND e.review_status = 'approved' THEN 'paid'
		ELSE 'unpaid'
	END,
	paid_at = CASE
		WHEN e.status = 'posted' AND e.review_status = 'approved'
			THEN coalesce(e.paid_at, b.posted_date)
		ELSE NULL
	END,
	reconciled_at = NULL,
	reconciled_by_user_id = NULL,
	updated_at = now()
FROM bank_transaction b
WHERE b.expense_id = e.id
	AND b.status IN ('matched', 'created')
	AND (
		b.workspace_id <> e.workspace_id
		OR b.signed_amount_cents >= 0
		OR e.deleted_at IS NOT NULL
		OR e.status <> 'posted'
		OR e.review_status <> 'approved'
		OR e.payment_status <> 'reconciled'
		OR e.amount_cents <> -b.signed_amount_cents
		OR abs(e.expense_date - b.posted_date) > 3
		OR (b.source_currency IS NOT NULL AND b.source_currency <> e.currency)
	);
--> statement-breakpoint
UPDATE bank_transaction b
SET
	status = 'pending',
	expense_id = NULL,
	decided_by_user_id = NULL,
	decided_at = NULL
FROM expense e
WHERE b.expense_id = e.id
	AND b.status IN ('matched', 'created')
	AND (
		b.workspace_id <> e.workspace_id
		OR b.signed_amount_cents >= 0
		OR e.deleted_at IS NOT NULL
		OR e.status <> 'posted'
		OR e.review_status <> 'approved'
		OR e.payment_status <> 'reconciled'
		OR e.amount_cents <> -b.signed_amount_cents
		OR abs(e.expense_date - b.posted_date) > 3
		OR (b.source_currency IS NOT NULL AND b.source_currency <> e.currency)
	);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_bank_transaction_expense_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	linked_expense expense%ROWTYPE;
BEGIN
	IF NEW.expense_id IS NULL OR NEW.status NOT IN ('matched', 'created') THEN
		RETURN NEW;
	END IF;
	PERFORM pg_advisory_xact_lock(
		hashtextextended('expense-reconciliation:' || NEW.expense_id::text, 0)
	);

	SELECT * INTO linked_expense FROM expense WHERE id = NEW.expense_id;
	IF NOT FOUND
		OR NEW.workspace_id <> linked_expense.workspace_id
		OR NEW.signed_amount_cents >= 0
		OR linked_expense.deleted_at IS NOT NULL
		OR linked_expense.status <> 'posted'
		OR linked_expense.review_status <> 'approved'
		OR linked_expense.payment_status <> 'reconciled'
		OR linked_expense.amount_cents <> -NEW.signed_amount_cents
		OR abs(linked_expense.expense_date - NEW.posted_date) > 3
		OR (
			NEW.source_currency IS NOT NULL
			AND NEW.source_currency <> linked_expense.currency
		)
	THEN
		RAISE EXCEPTION 'bank transaction is incompatible with its linked expense'
			USING ERRCODE = '23514',
				CONSTRAINT = 'bank_transaction_expense_integrity_check';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_transaction_expense_integrity_trigger
BEFORE INSERT OR UPDATE OF status, expense_id, workspace_id, signed_amount_cents, posted_date, source_currency
ON bank_transaction
FOR EACH ROW
EXECUTE FUNCTION assert_bank_transaction_expense_integrity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_linked_expense_reconciliation_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		hashtextextended('expense-reconciliation:' || NEW.id::text, 0)
	);
	IF EXISTS (
		SELECT 1
		FROM bank_transaction b
		WHERE b.expense_id = NEW.id
			AND b.status IN ('matched', 'created')
			AND (
				b.workspace_id <> NEW.workspace_id
				OR b.signed_amount_cents >= 0
				OR NEW.deleted_at IS NOT NULL
				OR NEW.status <> 'posted'
				OR NEW.review_status <> 'approved'
				OR NEW.payment_status <> 'reconciled'
				OR NEW.amount_cents <> -b.signed_amount_cents
				OR abs(NEW.expense_date - b.posted_date) > 3
				OR (b.source_currency IS NOT NULL AND b.source_currency <> NEW.currency)
			)
	) THEN
		RAISE EXCEPTION 'expense mutation would invalidate a linked bank transaction'
			USING ERRCODE = '23514',
				CONSTRAINT = 'bank_transaction_expense_integrity_check';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER linked_expense_reconciliation_integrity_trigger
BEFORE UPDATE OF workspace_id, amount_cents, currency, expense_date, status, review_status, payment_status, deleted_at
ON expense
FOR EACH ROW
EXECUTE FUNCTION guard_linked_expense_reconciliation_integrity();
