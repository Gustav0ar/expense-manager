import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from './+page.server';

const mocks = vi.hoisted(() => ({
	listTrashedExpenses: vi.fn(),
	purgeTrashedExpense: vi.fn(),
	requireWorkspaceContext: vi.fn(),
	restoreTrashedExpense: vi.fn(),
	context: {
		workspaceId: 12,
		userId: 'trash-user',
		role: 'owner',
		locale: 'en'
	}
}));

vi.mock('$lib/server/services/expense-trash', () => ({
	listTrashedExpenses: mocks.listTrashedExpenses,
	purgeTrashedExpense: mocks.purgeTrashedExpense,
	restoreTrashedExpense: mocks.restoreTrashedExpense
}));

vi.mock('$lib/server/services/workspaces', () => ({
	requireWorkspaceContext: mocks.requireWorkspaceContext
}));

describe('expense trash page server', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
		mocks.listTrashedExpenses.mockResolvedValue({
			items: [{ id: 10 }],
			hasMore: true,
			nextCursor: 'next-cursor'
		});
	});

	it('passes the cursor to the service and exposes stable page navigation data', async () => {
		const url = new URL('http://localhost/app/expenses/trash?cursor=current-cursor');
		const result = await load({ url } as never);

		expect(mocks.listTrashedExpenses).toHaveBeenCalledWith(mocks.context, {
			cursor: 'current-cursor'
		});
		expect(result).toMatchObject({
			items: [{ id: 10 }],
			hasMore: true,
			nextCursor: 'next-cursor',
			isCursorPage: true,
			returnTo: '/app/expenses/trash?cursor=current-cursor',
			serverNow: expect.any(Date)
		});
	});

	it('keeps restore actions on the current cursor and rejects an external return path', async () => {
		const restoreRedirect = await actionRedirect(
			'restore',
			'/app/expenses/trash?cursor=current-cursor'
		);
		expect(isRedirect(restoreRedirect)).toBe(true);
		expect(restoreRedirect).toMatchObject({
			status: 303,
			location: '/app/expenses/trash?cursor=current-cursor'
		});
		expect(mocks.restoreTrashedExpense).toHaveBeenCalledWith(mocks.context, 10);

		const purgeRedirect = await actionRedirect('purge', 'https://example.com/escape');
		expect(isRedirect(purgeRedirect)).toBe(true);
		expect(purgeRedirect).toMatchObject({ location: '/app/expenses/trash' });
		expect(mocks.purgeTrashedExpense).toHaveBeenCalledWith(mocks.context, 10);
	});
});

async function actionRedirect(actionName: 'restore' | 'purge', returnTo: string) {
	const action = actions[actionName];
	if (!action) throw new Error(`${actionName} action is not registered`);
	const formData = new FormData();
	formData.set('id', '10');
	formData.set('returnTo', returnTo);
	try {
		await action({
			request: new Request(`http://localhost/app/expenses/trash?/${actionName}`, {
				method: 'POST',
				body: formData
			})
		} as never);
	} catch (redirectError) {
		return redirectError;
	}
	throw new Error(`Expected ${actionName} to redirect`);
}
