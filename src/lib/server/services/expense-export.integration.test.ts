import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import { db } from '$lib/server/db';
import {
	category,
	expense,
	expenseAttachment,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import { streamAnalyticalExpenseReport } from './expenses';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];

describe('analytical expense export streaming', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
		}
		for (const userId of userIds.splice(0)) await db.delete(user).where(eq(user.id, userId));
	});

	it('keyset-paginates every row in stable order and aggregates attachment counts per batch', async () => {
		const fixture = await createFixture();
		const expenseRows = await insertExpenses(fixture, [
			['Older', '2026-01-01'],
			['Middle A', '2026-06-15'],
			['Middle B', '2026-06-15'],
			['Newer A', '2026-07-10'],
			['Newer B', '2026-07-10']
		]);
		await db
			.insert(expenseAttachment)
			.values([
				attachmentValues(fixture, expenseRows[0]!.id, 'older-1'),
				attachmentValues(fixture, expenseRows[0]!.id, 'older-2'),
				attachmentValues(fixture, expenseRows[3]!.id, 'newer-1')
			]);

		const batches = [];
		for await (const batch of streamAnalyticalExpenseReport(
			fixture.context,
			{ from: '2026-01-01', to: '2026-12-31' },
			{ batchSize: 2 }
		)) {
			batches.push(batch);
		}
		const rows = batches.flat();

		expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
		expect(rows.map((row) => row.description)).toEqual([
			'Newer B',
			'Newer A',
			'Middle B',
			'Middle A',
			'Older'
		]);
		expect(rows.map((row) => row.attachmentCount)).toEqual([0, 1, 0, 0, 2]);
	});

	it('keeps one repeatable-read snapshot when rows change between batches', async () => {
		const fixture = await createFixture();
		const expenseRows = await insertExpenses(fixture, [
			['Snapshot oldest', '2026-01-01'],
			['Snapshot middle', '2026-06-15'],
			['Snapshot newest', '2026-07-10']
		]);
		const iterator = streamAnalyticalExpenseReport(
			fixture.context,
			{ from: '2026-01-01', to: '2026-12-31' },
			{ batchSize: 1 }
		)[Symbol.asyncIterator]();

		try {
			const first = await iterator.next();
			expect(first.value?.[0]?.description).toBe('Snapshot newest');

			await db
				.update(expense)
				.set({ description: 'Changed after snapshot' })
				.where(eq(expense.id, expenseRows[0]!.id));
			await insertExpenses(fixture, [['Inserted after snapshot', '2026-12-31']]);

			const remaining = [];
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				remaining.push(...next.value);
			}

			expect(remaining.map((row) => row.description)).toEqual([
				'Snapshot middle',
				'Snapshot oldest'
			]);
		} finally {
			await iterator.return?.(undefined);
		}
	});
});

async function createFixture() {
	const userId = `expense-export-${randomUUID()}`;
	await db.insert(user).values({
		id: userId,
		name: 'Expense export owner',
		email: `${userId}@example.com`,
		emailVerified: true
	});
	userIds.push(userId);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Expense export ${randomUUID()}`, createdByUserId: userId, currency: 'USD' })
		.returning({
			id: workspace.id,
			name: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn
		});
	workspaceIds.push(workspaceRow.id);
	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId,
		role: 'owner',
		status: 'active'
	});
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'Export category', color: '#123456' })
		.returning({ id: category.id });
	const context: WorkspaceContext = {
		userId,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		currency: workspaceRow.currency,
		weekStartsOn: workspaceRow.weekStartsOn,
		locale: 'en',
		role: 'owner'
	};
	return { context, categoryId: categoryRow.id };
}

async function insertExpenses(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	rows: Array<[description: string, expenseDate: string]>
) {
	return db
		.insert(expense)
		.values(
			rows.map(([description, expenseDate], index) => ({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description,
				amountCents: 1_000 + index,
				currency: fixture.context.currency,
				expenseDate
			}))
		)
		.returning({ id: expense.id });
}

function attachmentValues(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	expenseId: number,
	name: string
) {
	return {
		workspaceId: fixture.context.workspaceId,
		expenseId,
		uploadedByUserId: fixture.context.userId,
		originalName: `${name}.txt`,
		contentType: 'text/plain',
		sizeBytes: 1,
		storageKey: `${fixture.context.workspaceId}/${randomUUID()}`,
		sha256: randomUUID().replaceAll('-', '').padEnd(64, '0')
	};
}
