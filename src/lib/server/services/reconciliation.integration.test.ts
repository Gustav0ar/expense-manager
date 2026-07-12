import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	bankTransaction,
	category,
	expense,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import {
	createExpense,
	deleteExpense,
	reviewExpense,
	updateExpense,
	updateExpensePaymentStatus
} from './expenses';
import {
	decideBankTransaction,
	listReconciliationQueue,
	stageOfxTransactions
} from './reconciliation';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];

describe.sequential('OFX reconciliation integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0))
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
		for (const userId of userIds.splice(0)) await db.delete(user).where(eq(user.id, userId));
	});

	it('stages re-uploads idempotently and returns deterministic candidates without mutating expenses', async () => {
		const fixture = await createFixture();
		const exact = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Mercado Central groceries',
			amount: '42.35',
			expenseDate: '2026-07-10'
		});
		await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Other purchase',
			amount: '42.35',
			expenseDate: '2026-07-12'
		});
		const file = statement([
			'<STMTTRN><DTPOSTED>20260710<TRNAMT>-42.35<FITID>debit-1<NAME>Mercado Central</STMTTRN>',
			'<STMTTRN><DTPOSTED>20260711<TRNAMT>9.00<FITID>credit-1<NAME>Refund</STMTTRN>'
		]);

		await expect(stageOfxTransactions(fixture.context, file)).resolves.toMatchObject({
			stagedCount: 2,
			duplicateCount: 0
		});
		await expect(stageOfxTransactions(fixture.context, file)).resolves.toMatchObject({
			stagedCount: 0,
			duplicateCount: 2
		});
		const queue = await listReconciliationQueue(fixture.context);
		expect(queue).toHaveLength(2);
		expect(queue[0]?.candidates.map((row) => row.id)).toEqual([exact.id, expect.any(Number)]);
		expect(queue[0]?.candidates[0]).toMatchObject({ dateDistanceDays: 0, textScore: 67 });
		expect(queue[1]).toMatchObject({ isCredit: true, candidates: [] });
		const [unchanged] = await db
			.select({ paymentStatus: expense.paymentStatus })
			.from(expense)
			.where(eq(expense.id, exact.id));
		expect(unchanged.paymentStatus).toBe('unpaid');
	});

	it('ranks the best eight candidates per transaction beyond one thousand eligible expenses', async () => {
		const fixture = await createFixture();
		const rows = await db
			.insert(expense)
			.values(
				Array.from({ length: 1005 }, (_, index) => ({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: index === 1004 ? 'Needle target' : `Unrelated candidate ${index}`,
					amountCents: 7777,
					currency: fixture.context.currency,
					expenseDate: '2026-07-10'
				}))
			)
			.returning({ id: expense.id, description: expense.description });
		const best = rows.at(-1)!;
		const secondRows = await db
			.insert(expense)
			.values(
				Array.from({ length: 9 }, (_, index) => ({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: index === 8 ? 'Second needle' : `Second decoy ${index}`,
					amountCents: 8888,
					currency: fixture.context.currency,
					expenseDate: '2026-07-10'
				}))
			)
			.returning({ id: expense.id, description: expense.description });
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-77.77<FITID>large-candidate-set<NAME>Needle target</STMTTRN>',
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-88.88<FITID>second-candidate-set<NAME>Second needle</STMTTRN>'
			])
		);

		const [transaction, secondTransaction] = await listReconciliationQueue(fixture.context);
		expect(transaction.candidates).toHaveLength(8);
		expect(transaction.candidates[0]).toMatchObject({
			id: best.id,
			description: 'Needle target',
			dateDistanceDays: 0,
			textScore: 100
		});
		expect(secondTransaction.candidates).toHaveLength(8);
		expect(secondTransaction.candidates[0]).toMatchObject({
			id: secondRows.at(-1)!.id,
			description: 'Second needle',
			dateDistanceDays: 0,
			textScore: 100
		});
	});

	it('uses accent-insensitive token overlap in SQL candidate ranking', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Café São Paulo market',
			amount: '64.00',
			expenseDate: '2026-07-10'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-64.00<FITID>accent-ranking<NAME>Cafe Sao Paulo</STMTTRN>'
			])
		);

		const [transaction] = await listReconciliationQueue(fixture.context);
		expect(transaction.candidates[0]).toMatchObject({
			id: created.id,
			dateDistanceDays: 0,
			textScore: 75
		});
	});

	it('validates uploads and returns a credit-only queue without candidates', async () => {
		const fixture = await createFixture();
		await expect(
			stageOfxTransactions(fixture.context, new File([], '', { type: 'application/x-ofx' }))
		).rejects.toMatchObject({ status: 400 });
		await expect(
			stageOfxTransactions(
				fixture.context,
				new File([new Uint8Array(1024 * 1024 + 1)], 'large.ofx', {
					type: 'application/x-ofx'
				})
			)
		).rejects.toMatchObject({ status: 400 });
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>1.00<FITID>credit-only<NAME>Credit only</STMTTRN>'
			])
		);
		await expect(listReconciliationQueue(fixture.context, { dateWindowDays: 99 })).resolves.toEqual(
			[expect.objectContaining({ isCredit: true, candidates: [] })]
		);
	});

	it('atomically matches, audits and replays the same confirmation', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Electric bill',
			amount: '80.00',
			expenseDate: '2026-07-09'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-80.00<FITID>match-1<NAME>Electric bill</STMTTRN>'
			])
		);
		const [transaction] = await listReconciliationQueue(fixture.context);
		const input = {
			transactionId: transaction.id,
			decision: 'match' as const,
			expenseId: created.id
		};
		await expect(decideBankTransaction(fixture.context, input)).resolves.toEqual({
			status: 'matched',
			expenseId: created.id
		});
		await expect(decideBankTransaction(fixture.context, input)).resolves.toEqual({
			status: 'matched',
			expenseId: created.id
		});
		const [row] = await db.select().from(expense).where(eq(expense.id, created.id));
		expect(row).toMatchObject({
			paymentStatus: 'reconciled',
			paidAt: '2026-07-10',
			reconciledByUserId: fixture.context.userId
		});
		const decisionAudits = await db
			.select({
				action: auditEvent.action,
				entityId: auditEvent.entityId,
				metadata: auditEvent.metadata
			})
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					inArray(auditEvent.action, ['bank_transaction.matched', 'expense.payment_reconciled'])
				)
			);
		expect(decisionAudits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: 'bank_transaction.matched',
					entityId: String(transaction.id)
				}),
				{
					action: 'expense.payment_reconciled',
					entityId: String(created.id),
					metadata: { paidAt: '2026-07-10', bankTransactionId: transaction.id }
				}
			])
		);
		expect(decisionAudits).toHaveLength(2);
	});

	it('preserves decided ledger history when a future retention purge removes the expense', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Future purge',
			amount: '11.00',
			expenseDate: '2026-07-10'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-11.00<FITID>purge-history<NAME>Future purge</STMTTRN>'
			])
		);
		const [transaction] = await listReconciliationQueue(fixture.context);
		await decideBankTransaction(fixture.context, {
			transactionId: transaction.id,
			decision: 'match',
			expenseId: created.id
		});
		await db.delete(expense).where(eq(expense.id, created.id));
		const [ledger] = await db
			.select({ status: bankTransaction.status, expenseId: bankTransaction.expenseId })
			.from(bankTransaction)
			.where(eq(bankTransaction.id, transaction.id));
		expect(ledger).toEqual({ status: 'matched', expenseId: null });
	});

	it('keeps mismatched currency visible but blocks match/create while allowing ignore', async () => {
		const fixture = await createFixture();
		await stageOfxTransactions(
			fixture.context,
			statement(
				['<STMTTRN><DTPOSTED>20260710<TRNAMT>-13.00<FITID>usd-row<NAME>USD debit</STMTTRN>'],
				'USD'
			)
		);
		const [transaction] = await listReconciliationQueue(fixture.context);
		expect(transaction).toMatchObject({
			sourceCurrency: 'USD',
			currencyMismatch: true,
			candidates: []
		});
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: transaction.id,
				decision: 'create',
				categoryId: fixture.categoryId
			})
		).rejects.toMatchObject({ status: 409 });
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: transaction.id,
				decision: 'ignore'
			})
		).resolves.toMatchObject({ status: 'ignored' });
	});

	it('accepts legacy statements without CURDEF using the workspace currency policy', async () => {
		const fixture = await createFixture();
		await stageOfxTransactions(
			fixture.context,
			new File(
				[
					'<OFX><BANKACCTFROM><BANKID>001<ACCTID>legacy</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260710<TRNAMT>-6.00<FITID>legacy-currency<NAME>Legacy debit</STMTTRN></BANKTRANLIST></OFX>'
				],
				'legacy.ofx',
				{ type: 'application/x-ofx' }
			)
		);
		const [transaction] = await listReconciliationQueue(fixture.context);
		expect(transaction).toMatchObject({ sourceCurrency: 'BRL', currencyMismatch: false });
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: transaction.id,
				decision: 'create',
				categoryId: fixture.categoryId
			})
		).resolves.toMatchObject({ status: 'created' });
	});

	it('enforces one-to-one matching under concurrency', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Concurrent candidate',
			amount: '19.90',
			expenseDate: '2026-07-10'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-19.90<FITID>concurrent-a<NAME>Candidate A</STMTTRN>',
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-19.90<FITID>concurrent-b<NAME>Candidate B</STMTTRN>'
			])
		);
		const queue = await listReconciliationQueue(fixture.context);
		const results = await Promise.allSettled(
			queue.map((row) =>
				decideBankTransaction(fixture.context, {
					transactionId: row.id,
					decision: 'match',
					expenseId: created.id
				})
			)
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(
			await db.select().from(bankTransaction).where(eq(bankTransaction.expenseId, created.id))
		).toHaveLength(1);
	});

	it('atomically reopens linked bank decisions before incompatible generic mutations', async () => {
		const fixture = await createFixture();
		const edited = await createAndMatchExpense(fixture, {
			description: 'Edit reconciliation',
			amount: '21.00',
			expenseDate: '2026-07-10',
			fitId: 'reverse-edit'
		});
		await updateExpense(fixture.context, edited.expenseId, {
			categoryId: fixture.categoryId,
			description: 'Edit reconciliation corrected',
			amount: '22.00',
			expenseDate: '2026-07-10'
		});
		await expectReversed(edited.transactionId, edited.expenseId, {
			paymentStatus: 'paid',
			amountCents: 2200,
			deletedAt: null
		});

		const rejected = await createAndMatchExpense(fixture, {
			description: 'Reject reconciliation',
			amount: '23.00',
			expenseDate: '2026-07-11',
			fitId: 'reverse-reject'
		});
		await reviewExpense(fixture.context, rejected.expenseId, {
			reviewStatus: 'rejected',
			reason: 'Not a workspace expense'
		});
		await expectReversed(rejected.transactionId, rejected.expenseId, {
			paymentStatus: 'unpaid',
			reviewStatus: 'rejected',
			deletedAt: null
		});

		const unpaid = await createAndMatchExpense(fixture, {
			description: 'Payment reconciliation',
			amount: '24.00',
			expenseDate: '2026-07-12',
			fitId: 'reverse-payment'
		});
		await updateExpensePaymentStatus(fixture.context, unpaid.expenseId, {
			paymentStatus: 'unpaid'
		});
		await expectReversed(unpaid.transactionId, unpaid.expenseId, {
			paymentStatus: 'unpaid',
			paidAt: null,
			deletedAt: null
		});

		const trashed = await createAndMatchExpense(fixture, {
			description: 'Trash reconciliation',
			amount: '25.00',
			expenseDate: '2026-07-13',
			fitId: 'reverse-trash'
		});
		await deleteExpense(fixture.context, trashed.expenseId);
		await expectReversed(trashed.transactionId, trashed.expenseId, {
			paymentStatus: 'paid',
			deletedAt: expect.any(Date)
		});

		const reversals = await db
			.select({ action: auditEvent.action, metadata: auditEvent.metadata })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					eq(auditEvent.action, 'bank_transaction.reversed')
				)
			);
		expect(reversals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					metadata: expect.objectContaining({ reason: 'expense_edited' })
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({ reason: 'expense_rejected' })
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({ reason: 'payment_status_changed' })
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({ reason: 'expense_trashed' })
				})
			])
		);
		expect(reversals).toHaveLength(4);
		expect(
			await db
				.select({ id: auditEvent.id })
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						eq(auditEvent.action, 'bank_transaction.matched')
					)
				)
		).toHaveLength(4);
	});

	it('keeps compatible edits linked and blocks direct incompatible writes', async () => {
		const fixture = await createFixture();
		const linked = await createAndMatchExpense(fixture, {
			description: 'Compatible edit',
			amount: '31.00',
			expenseDate: '2026-07-10',
			fitId: 'compatible-edit'
		});
		await updateExpense(fixture.context, linked.expenseId, {
			categoryId: fixture.categoryId,
			description: 'Compatible edit with clearer notes',
			amount: '31.00',
			expenseDate: '2026-07-10',
			notes: 'Description-only changes retain the verified financial link.'
		});
		const [decision] = await db
			.select({ status: bankTransaction.status, expenseId: bankTransaction.expenseId })
			.from(bankTransaction)
			.where(eq(bankTransaction.id, linked.transactionId));
		expect(decision).toEqual({ status: 'matched', expenseId: linked.expenseId });

		await expect(
			db.update(expense).set({ amountCents: 3200 }).where(eq(expense.id, linked.expenseId))
		).rejects.toMatchObject({ cause: { code: '23514' } });
		const [unchanged] = await db
			.select({ amountCents: expense.amountCents, paymentStatus: expense.paymentStatus })
			.from(expense)
			.where(eq(expense.id, linked.expenseId));
		expect(unchanged).toEqual({ amountCents: 3100, paymentStatus: 'reconciled' });
	});

	it('serializes a generic edit behind an in-flight match and reverses the committed link', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Concurrent edit',
			amount: '41.00',
			expenseDate: '2026-07-10'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-41.00<FITID>concurrent-edit<NAME>Concurrent edit</STMTTRN>'
			])
		);
		const [transaction] = await db
			.select({ id: bankTransaction.id })
			.from(bankTransaction)
			.where(eq(bankTransaction.providerTransactionId, 'concurrent-edit'));
		let releaseMatch!: () => void;
		const matchCanFinish = new Promise<void>((resolve) => (releaseMatch = resolve));
		let matchLocked!: () => void;
		const matchHasLocks = new Promise<void>((resolve) => (matchLocked = resolve));
		const matching = decideBankTransaction(
			fixture.context,
			{ transactionId: transaction.id, decision: 'match', expenseId: created.id },
			{
				onBeforeAudit: async () => {
					matchLocked();
					await matchCanFinish;
				}
			}
		);
		await matchHasLocks;
		const editing = updateExpense(fixture.context, created.id, {
			categoryId: fixture.categoryId,
			description: 'Concurrent edit changed',
			amount: '42.00',
			expenseDate: '2026-07-10'
		});
		releaseMatch();
		await expect(Promise.all([matching, editing])).resolves.toHaveLength(2);
		await expectReversed(transaction.id, created.id, {
			amountCents: 4200,
			paymentStatus: 'paid',
			deletedAt: null
		});
	});

	it('creates through the import path, ignores credits, and rejects unauthorized/cross-workspace decisions', async () => {
		const fixture = await createFixture();
		const other = await createFixture();
		const viewer = await createRoleContext(fixture, 'viewer');
		await expect(listReconciliationQueue(viewer)).resolves.toEqual([]);
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-12.00<FITID>create-1<NAME>New expense</STMTTRN>',
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>4.00<FITID>credit-ignore<NAME>Credit</STMTTRN>'
			])
		);
		const [debit, credit] = await listReconciliationQueue(fixture.context);
		await expect(
			decideBankTransaction(viewer, { transactionId: debit.id, decision: 'ignore' })
		).rejects.toMatchObject({ status: 403 });
		await expect(
			decideBankTransaction(other.context, { transactionId: debit.id, decision: 'ignore' })
		).rejects.toMatchObject({ status: 404 });
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: credit.id,
				decision: 'create',
				categoryId: fixture.categoryId
			})
		).rejects.toMatchObject({ status: 400 });
		const created = await decideBankTransaction(fixture.context, {
			transactionId: debit.id,
			decision: 'create',
			categoryId: fixture.categoryId
		});
		expect(created).toMatchObject({ status: 'created', expenseId: expect.any(Number) });
		const [createdExpense] = await db
			.select()
			.from(expense)
			.where(eq(expense.id, created.expenseId!));
		expect(createdExpense).toMatchObject({
			description: 'New expense',
			paymentStatus: 'reconciled',
			importBatchId: expect.any(Number)
		});
		await expect(
			decideBankTransaction(fixture.context, { transactionId: credit.id, decision: 'ignore' })
		).resolves.toMatchObject({ status: 'ignored', expenseId: null });
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: credit.id,
				decision: 'ignore'
			})
		).resolves.toMatchObject({ status: 'ignored', expenseId: null });
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: debit.id,
				decision: 'create',
				categoryId: fixture.categoryId
			})
		).resolves.toMatchObject({ status: 'created', expenseId: created.expenseId });
		const createPaymentAudits = await db
			.select({ entityId: auditEvent.entityId, metadata: auditEvent.metadata })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					eq(auditEvent.action, 'expense.payment_reconciled'),
					eq(auditEvent.entityId, String(created.expenseId))
				)
			);
		expect(createPaymentAudits).toEqual([
			{
				entityId: String(created.expenseId),
				metadata: { paidAt: '2026-07-10', bankTransactionId: debit.id }
			}
		]);
		await expect(
			decideBankTransaction(fixture.context, {
				transactionId: debit.id,
				decision: 'ignore'
			})
		).rejects.toMatchObject({ status: 409 });
	});

	it('rolls back financial and staged state when audit insertion cannot proceed', async () => {
		const fixture = await createFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Rollback candidate',
			amount: '30.00',
			expenseDate: '2026-07-10'
		});
		await stageOfxTransactions(
			fixture.context,
			statement([
				'<STMTTRN><DTPOSTED>20260710<TRNAMT>-30.00<FITID>rollback-1<NAME>Rollback candidate</STMTTRN>'
			])
		);
		const [transaction] = await listReconciliationQueue(fixture.context);
		await expect(
			decideBankTransaction(
				fixture.context,
				{
					transactionId: transaction.id,
					decision: 'match',
					expenseId: created.id
				},
				{
					onBeforeAudit: () => {
						throw new Error('audit unavailable');
					}
				}
			)
		).rejects.toThrow('audit unavailable');
		const [expenseRow] = await db.select().from(expense).where(eq(expense.id, created.id));
		const [transactionRow] = await db
			.select()
			.from(bankTransaction)
			.where(eq(bankTransaction.id, transaction.id));
		expect(expenseRow.paymentStatus).toBe('unpaid');
		expect(transactionRow.status).toBe('pending');
		await expect(
			db
				.select()
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						inArray(auditEvent.action, ['bank_transaction.matched', 'expense.payment_reconciled'])
					)
				)
		).resolves.toHaveLength(0);
	});
});

async function createAndMatchExpense(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	input: { amount: string; description: string; expenseDate: string; fitId: string }
) {
	const created = await createExpense(fixture.context, {
		categoryId: fixture.categoryId,
		description: input.description,
		amount: input.amount,
		expenseDate: input.expenseDate
	});
	const compactDate = input.expenseDate.replaceAll('-', '');
	await stageOfxTransactions(
		fixture.context,
		statement([
			`<STMTTRN><DTPOSTED>${compactDate}<TRNAMT>-${input.amount}<FITID>${input.fitId}<NAME>${input.description}</STMTTRN>`
		])
	);
	const [transaction] = await db
		.select({ id: bankTransaction.id })
		.from(bankTransaction)
		.where(
			and(
				eq(bankTransaction.workspaceId, fixture.context.workspaceId),
				eq(bankTransaction.providerTransactionId, input.fitId)
			)
		);
	await decideBankTransaction(fixture.context, {
		transactionId: transaction.id,
		decision: 'match',
		expenseId: created.id
	});
	return { expenseId: created.id, transactionId: transaction.id };
}

async function expectReversed(
	transactionId: number,
	expenseId: number,
	expenseShape: Record<string, unknown>
) {
	const [decision] = await db
		.select({
			status: bankTransaction.status,
			expenseId: bankTransaction.expenseId,
			decidedAt: bankTransaction.decidedAt,
			decidedByUserId: bankTransaction.decidedByUserId
		})
		.from(bankTransaction)
		.where(eq(bankTransaction.id, transactionId));
	expect(decision).toEqual({
		status: 'pending',
		expenseId: null,
		decidedAt: null,
		decidedByUserId: null
	});
	const [expenseRow] = await db.select().from(expense).where(eq(expense.id, expenseId));
	expect(expenseRow).toMatchObject({
		...expenseShape,
		reconciledAt: null,
		reconciledByUserId: null
	});
}

async function createFixture() {
	const ownerId = `reconcile-owner-${randomUUID()}`;
	await db
		.insert(user)
		.values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com`, emailVerified: true });
	userIds.push(ownerId);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Reconcile ${randomUUID()}`, currency: 'BRL', createdByUserId: ownerId })
		.returning();
	workspaceIds.push(workspaceRow.id);
	await db
		.insert(workspaceMember)
		.values({ workspaceId: workspaceRow.id, userId: ownerId, role: 'owner', status: 'active' });
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'General', color: '#2563eb', icon: '💼' })
		.returning({ id: category.id });
	const context: WorkspaceContext = {
		userId: ownerId,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		weekStartsOn: workspaceRow.weekStartsOn,
		currency: workspaceRow.currency,
		locale: 'en',
		role: 'owner'
	};
	return { context, categoryId: categoryRow.id };
}

async function createRoleContext(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	role: WorkspaceContext['role']
) {
	const userId = `reconcile-${role}-${randomUUID()}`;
	await db
		.insert(user)
		.values({ id: userId, name: role, email: `${userId}@example.com`, emailVerified: true });
	userIds.push(userId);
	await db
		.insert(workspaceMember)
		.values({ workspaceId: fixture.context.workspaceId, userId, role, status: 'active' });
	return { ...fixture.context, userId, role };
}

function statement(transactions: string[], currency = 'BRL') {
	return new File(
		[
			`<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${currency}<BANKACCTFROM><BANKID>001<ACCTID>1234<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${transactions.join('')}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
		],
		'statement.ofx',
		{ type: 'application/x-ofx' }
	);
}
