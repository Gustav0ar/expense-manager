import { and, eq } from 'drizzle-orm';
import { auditEvent, bankTransaction } from '$lib/server/db/schema';
import { db } from '$lib/server/db';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LinkedBankTransaction = Pick<
	typeof bankTransaction.$inferSelect,
	'id' | 'status' | 'signedAmountCents' | 'postedDate' | 'sourceCurrency'
>;

export type ReconciliationExpenseState = {
	id: number;
	workspaceId: number;
	amountCents: number;
	currency: string;
	expenseDate: string;
	status: string;
	reviewStatus: string;
	paymentStatus: string;
	deletedAt: Date | null;
};

export type ReconciliationReversalReason =
	'expense_edited' | 'expense_rejected' | 'payment_status_changed' | 'expense_trashed';

/**
 * Lock the bank side before the expense row whenever a committed link exists.
 * This matches decideBankTransaction's bank-then-expense lock order.
 */
export async function lockLinkedBankTransaction(
	tx: Transaction,
	workspaceId: number,
	expenseId: number
) {
	const [linked] = await tx
		.select({
			id: bankTransaction.id,
			status: bankTransaction.status,
			signedAmountCents: bankTransaction.signedAmountCents,
			postedDate: bankTransaction.postedDate,
			sourceCurrency: bankTransaction.sourceCurrency
		})
		.from(bankTransaction)
		.where(
			and(eq(bankTransaction.workspaceId, workspaceId), eq(bankTransaction.expenseId, expenseId))
		)
		.limit(1)
		.for('update');
	return linked ?? null;
}

export function isLinkedReconciliationCompatible(
	linked: LinkedBankTransaction,
	expenseState: ReconciliationExpenseState
) {
	return (
		(linked.status === 'matched' || linked.status === 'created') &&
		linked.signedAmountCents < 0 &&
		expenseState.deletedAt === null &&
		expenseState.status === 'posted' &&
		expenseState.reviewStatus === 'approved' &&
		expenseState.paymentStatus === 'reconciled' &&
		expenseState.amountCents === -linked.signedAmountCents &&
		daysApart(expenseState.expenseDate, linked.postedDate) <= 3 &&
		(linked.sourceCurrency === null || linked.sourceCurrency === expenseState.currency)
	);
}

export async function reverseLinkedBankTransaction(
	tx: Transaction,
	input: {
		actorUserId: string;
		expenseId: number;
		linked: LinkedBankTransaction;
		reason: ReconciliationReversalReason;
		workspaceId: number;
	}
) {
	const [reversed] = await tx
		.update(bankTransaction)
		.set({
			status: 'pending',
			expenseId: null,
			decidedByUserId: null,
			decidedAt: null
		})
		.where(
			and(
				eq(bankTransaction.id, input.linked.id),
				eq(bankTransaction.workspaceId, input.workspaceId),
				eq(bankTransaction.expenseId, input.expenseId),
				eq(bankTransaction.status, input.linked.status)
			)
		)
		.returning({ id: bankTransaction.id });
	if (!reversed) throw new Error('Linked bank transaction changed while reversing reconciliation.');

	await tx.insert(auditEvent).values({
		workspaceId: input.workspaceId,
		actorUserId: input.actorUserId,
		action: 'bank_transaction.reversed',
		entityType: 'bank_transaction',
		entityId: String(input.linked.id),
		metadata: {
			expenseId: input.expenseId,
			previousStatus: input.linked.status,
			reason: input.reason
		}
	});
}

function daysApart(left: string, right: string) {
	return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}
