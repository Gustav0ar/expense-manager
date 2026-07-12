import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listCategories: vi.fn(),
	listExpenseCatalogs: vi.fn(),
	requireWorkspaceContext: vi.fn()
}));

vi.mock('$lib/server/services/categories', () => ({ listCategories: mocks.listCategories }));
vi.mock('$lib/server/services/expense-catalogs', () => ({
	listExpenseCatalogs: mocks.listExpenseCatalogs
}));
vi.mock('$lib/server/services/workspaces', () => ({
	requireWorkspaceContext: mocks.requireWorkspaceContext
}));

import { GET } from './+server';

describe('expense management data endpoint', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue({ workspaceId: 12, userId: 'user-1' });
		mocks.listCategories.mockResolvedValue([{ id: 2, name: 'Archived', isArchived: true }]);
		mocks.listExpenseCatalogs.mockResolvedValue({
			paymentMethods: [],
			vendors: [{ id: 3, name: 'Past vendor', isArchived: true }],
			costCenters: []
		});
	});

	it('loads archived records and usage data only when management is requested', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(mocks.listCategories).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: 12 }),
			true
		);
		expect(mocks.listExpenseCatalogs).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: 12 }),
			true
		);
		expect(await response.json()).toEqual({
			categories: [{ id: 2, name: 'Archived', isArchived: true }],
			catalogs: {
				paymentMethods: [],
				vendors: [{ id: 3, name: 'Past vendor', isArchived: true }],
				costCenters: []
			}
		});
	});
});
