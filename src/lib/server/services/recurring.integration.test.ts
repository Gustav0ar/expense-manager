import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import {
	category,
	expense,
	recurringExpense,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import {
	createRecurringExpense,
	listRecurringExpenses,
	materializeDueRecurringExpenses,
	setRecurringExpenseStatus
} from './recurring';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];

describe('recurring expense service integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
		}
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
	});

	it('creates, lists, pauses and resumes a schedule within its workspace', async () => {
		const fixture = await createFixture();
		await expect(
			createRecurringExpense(
				{ ...fixture.context, role: 'viewer' },
				recurringInput(fixture.categoryId)
			)
		).rejects.toMatchObject({ status: 403 });

		const schedule = await createRecurringExpense(fixture.context, {
			...recurringInput(fixture.categoryId),
			paymentMethodId: null,
			notes: 'Monthly plan'
		});
		expect(await listRecurringExpenses(fixture.context)).toEqual([
			expect.objectContaining({
				id: schedule.id,
				description: 'Hosting',
				amountCents: 1_250,
				status: 'active',
				categoryId: fixture.categoryId,
				paymentMethod: null
			})
		]);

		await expect(
			setRecurringExpenseStatus({ ...fixture.context, role: 'viewer' }, schedule.id, 'paused')
		).rejects.toMatchObject({ status: 403 });
		await expect(
			setRecurringExpenseStatus(fixture.context, schedule.id, 'paused')
		).resolves.toBeUndefined();
		await expect(
			setRecurringExpenseStatus(fixture.context, schedule.id, 'active')
		).resolves.toBeUndefined();
		await expect(
			setRecurringExpenseStatus(fixture.context, 2_147_483_647, 'paused')
		).rejects.toMatchObject({ status: 404 });
	});

	it('materializes each due occurrence once and pauses schedules after their end date', async () => {
		const fixture = await createFixture();
		const schedule = await createRecurringExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Weekly service',
			amount: '20.00',
			frequency: 'weekly',
			intervalCount: 1,
			startDate: '2026-06-01',
			endDate: '2026-06-15'
		});

		await expect(materializeDueRecurringExpenses(fixture.context, '2026-06-30')).resolves.toEqual({
			createdCount: 3
		});
		const generated = await db
			.select({ date: expense.expenseDate, reviewStatus: expense.reviewStatus })
			.from(expense)
			.where(eq(expense.sourceRecurringExpenseId, schedule.id));
		expect(generated).toEqual([
			{ date: '2026-06-01', reviewStatus: 'approved' },
			{ date: '2026-06-08', reviewStatus: 'approved' },
			{ date: '2026-06-15', reviewStatus: 'approved' }
		]);
		const [storedSchedule] = await db
			.select({ nextRunDate: recurringExpense.nextRunDate, status: recurringExpense.status })
			.from(recurringExpense)
			.where(eq(recurringExpense.id, schedule.id));
		expect(storedSchedule).toEqual({ nextRunDate: '2026-06-22', status: 'paused' });

		await expect(materializeDueRecurringExpenses(fixture.context, '2026-06-30')).resolves.toEqual({
			createdCount: 0
		});
	});

	it('rejects unauthorized materialization and categories from another workspace', async () => {
		const fixture = await createFixture();
		const other = await createFixture();
		await expect(
			materializeDueRecurringExpenses({ ...fixture.context, role: 'viewer' }, '2026-06-30')
		).rejects.toMatchObject({ status: 403 });
		await expect(
			createRecurringExpense(fixture.context, recurringInput(other.categoryId))
		).rejects.toMatchObject({ status: 400 });
	});
});

function recurringInput(categoryId: number) {
	return {
		categoryId,
		description: 'Hosting',
		amount: '12.50',
		frequency: 'monthly' as const,
		intervalCount: 1,
		startDate: '2026-07-01'
	};
}

async function createFixture() {
	const id = `recurring-${randomUUID()}`;
	await db.insert(user).values({
		id,
		name: 'Recurring owner',
		email: `${id}@example.com`,
		emailVerified: true
	});
	userIds.push(id);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Recurring ${randomUUID()}`, createdByUserId: id, currency: 'USD' })
		.returning({
			id: workspace.id,
			name: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn
		});
	workspaceIds.push(workspaceRow.id);
	await db
		.insert(workspaceMember)
		.values({ workspaceId: workspaceRow.id, userId: id, role: 'owner', status: 'active' });
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'Services', color: '#112233' })
		.returning({ id: category.id });
	const context: WorkspaceContext = {
		userId: id,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		currency: workspaceRow.currency,
		weekStartsOn: workspaceRow.weekStartsOn,
		locale: 'en',
		role: 'owner'
	};
	return { context, categoryId: categoryRow.id };
}
