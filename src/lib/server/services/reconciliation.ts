import { error } from '@sveltejs/kit';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { translate } from '$lib/i18n';
import { maxMoneyCents } from '$lib/money-limits';
import { db } from '$lib/server/db';
import { auditEvent, bankTransaction, category, expense, importBatch } from '$lib/server/db/schema';
import { canReconcileExpenses } from '$lib/server/security/roles';
import { sha256 } from '$lib/server/utils/crypto';
import { insertImportedExpenseRows } from './imports';
import type { WorkspaceContext } from './workspaces';
import { lockWorkspaceCurrency } from './workspace-currency';

const maxOfxBytes = 1024 * 1024;
const maxOfxRows = 500;
export const reconciliationDateWindowDays = 3;

export type ParsedOfxTransaction = {
	rowNumber: number;
	providerTransactionId: string | null;
	postedDate: string;
	signedAmountCents: number;
	description: string;
	memo: string | null;
	sourceIdentity: string;
};

export type ReconciliationCandidate = {
	id: number;
	description: string;
	amountCents: number;
	expenseDate: string;
	paymentStatus: string;
	dateDistanceDays: number;
	textScore: number;
};

export type ReconciliationQueueItem = {
	id: number;
	postedDate: string;
	signedAmountCents: number;
	description: string;
	memo: string | null;
	sourceCurrency: string | null;
	currencyMismatch: boolean;
	isCredit: boolean;
	candidates: ReconciliationCandidate[];
};

export function parseOfxForReconciliation(content: string, locale = 'en') {
	const blocks = [...content.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi)];
	if (blocks.length === 0) throw error(400, translate(locale, 'No OFX transaction found.'));
	if (blocks.length > maxOfxRows)
		throw error(
			400,
			translate(locale, 'Import at most {count} rows at a time.', { count: maxOfxRows })
		);

	const accountMaterial = JSON.stringify(
		['BANKID', 'BRANCHID', 'ACCTID', 'ACCTTYPE', 'CURDEF'].map((tag) =>
			(readOfxTag(content, tag) ?? '').trim().toUpperCase()
		)
	);
	const sourceAccountFingerprint = sha256(accountMaterial);
	const rawCurrency = readOfxTag(content, 'CURDEF');
	const sourceCurrency = rawCurrency?.trim().toUpperCase() || null;
	if (sourceCurrency && !/^[A-Z]{3}$/.test(sourceCurrency))
		throw error(400, translate(locale, 'OFX statement currency is invalid.'));
	const fallbackOccurrences = new Map<string, number>();
	const transactions: ParsedOfxTransaction[] = [];
	const errors: Array<{ rowNumber: number; message: string }> = [];

	for (const [index, match] of blocks.entries()) {
		const block = match[1];
		const rowNumber = index + 1;
		const postedDate = parseOfxDate(readOfxTag(block, 'DTPOSTED') ?? '');
		const signedAmountCents = parseSignedAmount(readOfxTag(block, 'TRNAMT') ?? '');
		const description = (readOfxTag(block, 'NAME') ?? readOfxTag(block, 'MEMO') ?? '')
			.trim()
			.slice(0, 160);
		const memoValue = readOfxTag(block, 'MEMO')?.trim().slice(0, 1000) || null;
		const providerTransactionId = readOfxTag(block, 'FITID')?.trim().slice(0, 255) || null;
		if (!postedDate || signedAmountCents === null || !description) {
			errors.push({
				rowNumber,
				message: translate(
					locale,
					'OFX transaction {rowNumber}: date, amount or description is invalid.',
					{
						rowNumber
					}
				)
			});
			continue;
		}
		const fallbackMaterial = [
			postedDate,
			String(signedAmountCents),
			normalizeIdentityText(description),
			normalizeIdentityText(memoValue ?? '')
		].join('|');
		const occurrence = (fallbackOccurrences.get(fallbackMaterial) ?? 0) + 1;
		fallbackOccurrences.set(fallbackMaterial, occurrence);
		const transactionMaterial = providerTransactionId
			? `fitid:${providerTransactionId}`
			: `fallback:${fallbackMaterial}|${occurrence}`;
		transactions.push({
			rowNumber,
			providerTransactionId,
			postedDate,
			signedAmountCents,
			description,
			memo: memoValue && memoValue !== description ? memoValue : null,
			sourceIdentity: sha256(`${sourceAccountFingerprint}|${transactionMaterial}`)
		});
	}
	return { sourceAccountFingerprint, sourceCurrency, transactions, errors };
}

export async function stageOfxTransactions(context: WorkspaceContext, file: File) {
	assertReconciler(context);
	if (!file || file.size === 0) throw error(400, translate(context.locale, 'File is required.'));
	if (file.size > maxOfxBytes)
		throw error(400, translate(context.locale, 'File is larger than 1 MB.'));
	const content = await file.text();
	const parsed = parseOfxForReconciliation(content, context.locale);
	const now = new Date();
	const sourceChecksum = sha256(content);
	const fileName = file.name.slice(0, 180) || 'statement.ofx';
	return db.transaction(async (tx) => {
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		const inserted =
			parsed.transactions.length === 0
				? []
				: await tx
						.insert(bankTransaction)
						.values(
							parsed.transactions.map((row) => ({
								workspaceId: context.workspaceId,
								uploadedByUserId: context.userId,
								sourceAccountFingerprint: parsed.sourceAccountFingerprint,
								sourceIdentity: row.sourceIdentity,
								sourceChecksum,
								sourceCurrency: parsed.sourceCurrency ?? currentCurrency,
								providerTransactionId: row.providerTransactionId,
								fileName,
								postedDate: row.postedDate,
								signedAmountCents: row.signedAmountCents,
								description: row.description,
								memo: row.memo,
								createdAt: now
							}))
						)
						.onConflictDoNothing({
							target: [bankTransaction.workspaceId, bankTransaction.sourceIdentity]
						})
						.returning({ id: bankTransaction.id });
		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'bank_statement.staged',
			entityType: 'bank_statement',
			entityId: sourceChecksum,
			metadata: {
				fileName,
				rowCount: parsed.transactions.length + parsed.errors.length,
				stagedCount: inserted.length,
				duplicateCount: parsed.transactions.length - inserted.length,
				failedCount: parsed.errors.length
			}
		});
		return {
			stagedCount: inserted.length,
			duplicateCount: parsed.transactions.length - inserted.length,
			failedCount: parsed.errors.length,
			failedRows: parsed.errors
		};
	});
}

export async function listReconciliationQueue(
	context: WorkspaceContext,
	options: { dateWindowDays?: number } = {}
): Promise<ReconciliationQueueItem[]> {
	if (!canReconcileExpenses(context.role)) return [];
	const dateWindowDays = boundedDateWindow(options.dateWindowDays);
	const rows = await db.execute<ReconciliationQueueSqlRow>(sql`
		with pending_transactions as (
			select
				bt.id,
				bt.posted_date,
				bt.signed_amount_cents,
				bt.description,
				bt.memo,
				bt.source_currency,
				array(
					select distinct token
					from regexp_split_to_table(
						trim(regexp_replace(
							regexp_replace(lower(normalize(bt.description, NFKD)), U&'[\\0300-\\036f]', '', 'g'),
							'[^a-z0-9]+', ' ', 'g'
						)),
						'[[:space:]]+'
					) as token
					where length(token) > 1
				) as description_tokens
			from bank_transaction bt
			where bt.workspace_id = ${context.workspaceId}
				and bt.status = 'pending'
			order by bt.posted_date asc, bt.id asc
			limit 100
		)
		select
			t.id as transaction_id,
			t.posted_date,
			t.signed_amount_cents,
			t.description as transaction_description,
			t.memo,
			t.source_currency,
			candidate.id as candidate_id,
			candidate.description as candidate_description,
			candidate.amount_cents as candidate_amount_cents,
			candidate.expense_date as candidate_expense_date,
			candidate.payment_status as candidate_payment_status,
			candidate.date_distance_days,
			candidate.text_score
		from pending_transactions t
		left join lateral (
			select ranked.*
			from (
				select
					e.id,
					e.description,
					e.amount_cents,
					e.expense_date,
					e.payment_status,
					abs(e.expense_date - t.posted_date)::int as date_distance_days,
					coalesce(round(
						100.0 * (
							select count(*)
							from (
								select token from unnest(t.description_tokens) as token
								intersect
								select token from unnest(expense_text.tokens) as token
							) shared_tokens
						) / nullif((
							select count(*)
							from (
								select token from unnest(t.description_tokens) as token
								union
								select token from unnest(expense_text.tokens) as token
							) combined_tokens
						), 0)
					), 0)::int as text_score
				from expense e
				cross join lateral (
					select array(
						select distinct token
						from regexp_split_to_table(
							trim(regexp_replace(
								regexp_replace(lower(normalize(e.description, NFKD)), U&'[\\0300-\\036f]', '', 'g'),
								'[^a-z0-9]+', ' ', 'g'
							)),
							'[[:space:]]+'
						) as token
						where length(token) > 1
					) as tokens
				) expense_text
				where t.signed_amount_cents < 0
					and (t.source_currency is null or t.source_currency = ${context.currency})
					and e.workspace_id = ${context.workspaceId}
					and e.deleted_at is null
					and e.status = 'posted'
					and e.review_status = 'approved'
					and e.payment_status in ('unpaid', 'paid')
					and e.amount_cents = -t.signed_amount_cents
					and abs(e.expense_date - t.posted_date) <= ${dateWindowDays}
			) ranked
			order by
				ranked.date_distance_days asc,
				ranked.text_score desc,
				ranked.expense_date asc,
				ranked.id asc
			limit 8
		) candidate on true
		order by t.posted_date asc, t.id asc,
			candidate.date_distance_days asc,
			candidate.text_score desc,
			candidate.expense_date asc,
			candidate.id asc
	`);

	const queue = new Map<number, ReconciliationQueueItem>();
	for (const row of rows) {
		const id = Number(row.transaction_id);
		let transaction = queue.get(id);
		if (!transaction) {
			const signedAmountCents = Number(row.signed_amount_cents);
			const sourceCurrency = row.source_currency;
			transaction = {
				id,
				postedDate: row.posted_date,
				signedAmountCents,
				description: row.transaction_description,
				memo: row.memo,
				sourceCurrency,
				isCredit: signedAmountCents > 0,
				currencyMismatch: sourceCurrency !== null && sourceCurrency !== context.currency,
				candidates: []
			};
			queue.set(id, transaction);
		}
		if (row.candidate_id !== null) {
			transaction.candidates.push({
				id: Number(row.candidate_id),
				description: row.candidate_description!,
				amountCents: Number(row.candidate_amount_cents),
				expenseDate: row.candidate_expense_date!,
				paymentStatus: row.candidate_payment_status!,
				dateDistanceDays: Number(row.date_distance_days),
				textScore: Number(row.text_score)
			});
		}
	}
	return [...queue.values()];
}

type ReconciliationQueueSqlRow = {
	transaction_id: number | string;
	posted_date: string;
	signed_amount_cents: number | string;
	transaction_description: string;
	memo: string | null;
	source_currency: string | null;
	candidate_id: number | string | null;
	candidate_description: string | null;
	candidate_amount_cents: number | string | null;
	candidate_expense_date: string | null;
	candidate_payment_status: string | null;
	date_distance_days: number | null;
	text_score: number | null;
};

export async function decideBankTransaction(
	context: WorkspaceContext,
	input:
		| { transactionId: number; decision: 'ignore' }
		| { transactionId: number; decision: 'match'; expenseId: number }
		| { transactionId: number; decision: 'create'; categoryId: number },
	options: { now?: Date; onBeforeAudit?: () => void | Promise<void> } = {}
) {
	assertReconciler(context);
	const now = options.now ?? new Date();
	return db.transaction(async (tx) => {
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		const currentContext = { ...context, currency: currentCurrency };
		const [transaction] = await tx
			.select()
			.from(bankTransaction)
			.where(
				and(
					eq(bankTransaction.id, input.transactionId),
					eq(bankTransaction.workspaceId, context.workspaceId)
				)
			)
			.limit(1)
			.for('update');
		if (!transaction) throw error(404, translate(context.locale, 'Bank transaction not found.'));
		if (transaction.status !== 'pending') {
			if (
				(input.decision === 'ignore' && transaction.status === 'ignored') ||
				(input.decision === 'match' &&
					transaction.status === 'matched' &&
					transaction.expenseId === input.expenseId) ||
				(input.decision === 'create' && transaction.status === 'created')
			)
				return { status: transaction.status, expenseId: transaction.expenseId };
			throw error(409, translate(context.locale, 'Bank transaction was already decided.'));
		}
		if (transaction.signedAmountCents > 0 && input.decision !== 'ignore')
			throw error(400, translate(context.locale, 'Credit transactions can only be ignored.'));
		if (
			transaction.sourceCurrency !== null &&
			transaction.sourceCurrency !== currentCurrency &&
			input.decision !== 'ignore'
		)
			throw error(
				409,
				translate(
					context.locale,
					'Bank transaction currency does not match the workspace currency.'
				)
			);

		let expenseId: number | null = null;
		let reconciledPaidAt: string | null = null;
		let status: 'matched' | 'created' | 'ignored';
		if (input.decision === 'match') {
			const [candidate] = await tx
				.select({
					id: expense.id,
					expenseDate: expense.expenseDate,
					paymentStatus: expense.paymentStatus,
					paidAt: expense.paidAt
				})
				.from(expense)
				.where(
					and(
						eq(expense.id, input.expenseId),
						eq(expense.workspaceId, context.workspaceId),
						isNull(expense.deletedAt),
						eq(expense.status, 'posted'),
						eq(expense.reviewStatus, 'approved'),
						inArray(expense.paymentStatus, ['unpaid', 'paid']),
						eq(expense.amountCents, -transaction.signedAmountCents)
					)
				)
				.limit(1)
				.for('update');
			if (
				!candidate ||
				daysApart(candidate.expenseDate, transaction.postedDate) > reconciliationDateWindowDays
			)
				throw error(
					409,
					translate(context.locale, 'Expense is no longer eligible for this match.')
				);
			expenseId = candidate.id;
			reconciledPaidAt = candidate.paidAt ?? transaction.postedDate;
			await tx
				.update(expense)
				.set({
					paymentStatus: 'reconciled',
					paidAt: reconciledPaidAt,
					reconciledAt: now,
					reconciledByUserId: context.userId,
					updatedAt: now
				})
				.where(and(eq(expense.id, candidate.id), eq(expense.workspaceId, context.workspaceId)));
			status = 'matched';
		} else if (input.decision === 'create') {
			const [activeCategory] = await tx
				.select({ id: category.id, name: category.name })
				.from(category)
				.where(
					and(
						eq(category.id, input.categoryId),
						eq(category.workspaceId, context.workspaceId),
						eq(category.isArchived, false)
					)
				)
				.limit(1);
			if (!activeCategory)
				throw error(409, translate(context.locale, 'A proposed category is no longer available.'));
			const [batch] = await tx
				.insert(importBatch)
				.values({
					workspaceId: context.workspaceId,
					uploadedByUserId: context.userId,
					sourceType: 'ofx',
					fileName: transaction.fileName,
					rowCount: 1,
					importedCount: 1,
					createdAt: now
				})
				.returning({ id: importBatch.id });
			const [created] = await insertImportedExpenseRows(tx, currentContext, {
				rows: [
					{
						sourceRowId: `bank:${transaction.id}`,
						rowNumber: 1,
						expenseDate: transaction.postedDate,
						description: transaction.description,
						amountCents: -transaction.signedAmountCents,
						categoryId: activeCategory.id,
						categoryName: activeCategory.name,
						paymentMethod: 'OFX',
						notes: transaction.memo ?? undefined,
						isDuplicate: false
					}
				],
				batchId: batch.id,
				now,
				reviewStatus: 'approved',
				reviewedByUserId: context.userId,
				reviewedAt: now
			});
			expenseId = created.id;
			reconciledPaidAt = transaction.postedDate;
			await tx
				.update(expense)
				.set({
					paymentStatus: 'reconciled',
					paidAt: transaction.postedDate,
					reconciledAt: now,
					reconciledByUserId: context.userId,
					updatedAt: now
				})
				.where(and(eq(expense.id, expenseId), eq(expense.workspaceId, context.workspaceId)));
			await tx.insert(auditEvent).values({
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'expense_import.completed',
				entityType: 'import_batch',
				entityId: String(batch.id),
				metadata: {
					sourceType: 'ofx',
					importedCount: 1,
					reconciliationTransactionId: transaction.id
				}
			});
			status = 'created';
		} else {
			status = 'ignored';
		}

		if (expenseId !== null && reconciledPaidAt !== null) {
			await tx.insert(auditEvent).values({
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'expense.payment_reconciled',
				entityType: 'expense',
				entityId: String(expenseId),
				metadata: { paidAt: reconciledPaidAt, bankTransactionId: transaction.id }
			});
		}

		await tx
			.update(bankTransaction)
			.set({ status, expenseId, decidedByUserId: context.userId, decidedAt: now })
			.where(
				and(
					eq(bankTransaction.id, transaction.id),
					eq(bankTransaction.workspaceId, context.workspaceId)
				)
			);
		await options.onBeforeAudit?.();
		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: `bank_transaction.${status}`,
			entityType: 'bank_transaction',
			entityId: String(transaction.id),
			metadata: {
				expenseId,
				signedAmountCents: transaction.signedAmountCents,
				postedDate: transaction.postedDate
			}
		});
		return { status, expenseId };
	});
}

function assertReconciler(context: WorkspaceContext) {
	if (!canReconcileExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
}

function boundedDateWindow(value?: number) {
	return Number.isInteger(value) && value! >= 0 && value! <= 7
		? value!
		: reconciliationDateWindowDays;
}

function readOfxTag(block: string, tag: string) {
	const match = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i').exec(block);
	return match?.[1]?.trim();
}

function parseOfxDate(value: string) {
	const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
	if (!match) return null;
	const result = `${match[1]}-${match[2]}-${match[3]}`;
	const parsed = new Date(`${result}T00:00:00Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result
		? null
		: result;
}

function parseSignedAmount(value: string) {
	const normalized = value.trim().replace(',', '.');
	if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
	const sign = normalized.startsWith('-') ? -1 : 1;
	const unsigned = normalized.replace(/^[+-]/, '');
	const [whole, fraction = ''] = unsigned.split('.');
	const digits = `${whole}${fraction.padEnd(2, '0')}`.replace(/^0+/, '') || '0';
	if (digits.length > String(maxMoneyCents).length) return null;
	const cents = Number(digits) * sign;
	return cents === 0 || Math.abs(cents) > maxMoneyCents ? null : cents;
}

export function normalizeReconciliationText(value: string) {
	return value
		.normalize('NFKD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function normalizeIdentityText(value: string) {
	return normalizeReconciliationText(value).replace(/\s+/g, ' ');
}

export function descriptionOverlap(left: string, right: string) {
	const leftTokens = new Set(
		normalizeReconciliationText(left)
			.split(' ')
			.filter((token) => token.length > 1)
	);
	const rightTokens = new Set(
		normalizeReconciliationText(right)
			.split(' ')
			.filter((token) => token.length > 1)
	);
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let shared = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
	return Math.round((shared / new Set([...leftTokens, ...rightTokens]).size) * 100);
}

function daysApart(left: string, right: string) {
	return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}
