import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import { category, expense, workspace, workspaceMember } from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import {
	createCategory,
	listCategories,
	removeCategory,
	unarchiveCategory,
	updateCategory
} from './categories';
import {
	assertCatalogName,
	catalogKindLabel,
	catalogLookupKey,
	createExpenseCatalogItem,
	getOrCreateCatalogItem,
	listExpenseCatalogs,
	normalizeCatalogName,
	removeExpenseCatalogItem,
	requireActiveCatalogItem,
	resolveExpenseCatalogSelection,
	updateExpenseCatalogItem
} from './expense-catalogs';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];

describe('category and expense catalog integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
		}
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
	});

	it('enforces category permissions, updates records and reports missing categories', async () => {
		const fixture = await createFixture();
		const denied = { ...fixture.context, role: 'viewer' as const };
		await expect(
			createCategory(denied, { name: 'Denied', color: '#000000' })
		).rejects.toMatchObject({
			status: 403
		});
		await expect(
			updateCategory(denied, fixture.categoryId, { name: 'Denied', color: '#000000' })
		).rejects.toMatchObject({ status: 403 });
		await expect(removeCategory(denied, fixture.categoryId)).rejects.toMatchObject({ status: 403 });
		await expect(unarchiveCategory(denied, fixture.categoryId)).rejects.toMatchObject({
			status: 403
		});

		await expect(
			updateCategory(fixture.context, fixture.categoryId, {
				name: 'Updated category',
				color: '#abcdef',
				icon: ''
			})
		).resolves.toBeUndefined();
		expect(await listCategories(fixture.context)).toContainEqual(
			expect.objectContaining({
				id: fixture.categoryId,
				name: 'Updated category',
				color: '#abcdef',
				icon: null,
				associationCount: 0
			})
		);
		await expect(
			updateCategory(fixture.context, 2_147_483_647, { name: 'Missing', color: '#000000' })
		).rejects.toMatchObject({ status: 404 });
		await expect(removeCategory(fixture.context, 2_147_483_647)).rejects.toMatchObject({
			status: 404
		});
		await expect(unarchiveCategory(fixture.context, 2_147_483_647)).rejects.toMatchObject({
			status: 404
		});
	});

	it('archives associated categories and prevents unarchiving a duplicate active name', async () => {
		const fixture = await createFixture();
		const used = await createCategory(fixture.context, {
			name: 'Duplicated category',
			color: '#334455',
			icon: '📦'
		});
		await db.insert(expense).values({
			workspaceId: fixture.context.workspaceId,
			categoryId: used.id,
			createdByUserId: fixture.context.userId,
			description: 'Associated expense',
			amountCents: 250,
			expenseDate: '2026-07-01'
		});
		await expect(removeCategory(fixture.context, used.id)).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 1, associationCount: 1 })
		});
		await createCategory(fixture.context, { name: 'Duplicated category', color: '#445566' });
		await expect(unarchiveCategory(fixture.context, used.id)).rejects.toMatchObject({
			status: 409
		});
		expect(await listCategories(fixture.context, true)).toContainEqual(
			expect.objectContaining({ id: used.id, isArchived: true, expenseCount: 1 })
		);
	});

	it('validates catalog names and enforces catalog permissions and workspace scope', async () => {
		const fixture = await createFixture();
		const denied = { ...fixture.context, role: 'viewer' as const };
		await expect(
			createExpenseCatalogItem(denied, { kind: 'vendor', name: 'Denied vendor' })
		).rejects.toMatchObject({ status: 403 });
		await expect(
			updateExpenseCatalogItem(denied, { kind: 'vendor', id: 1, name: 'Denied vendor' })
		).rejects.toMatchObject({ status: 403 });
		await expect(removeExpenseCatalogItem(denied, { kind: 'vendor', id: 1 })).rejects.toMatchObject(
			{ status: 403 }
		);

		expect(normalizeCatalogName('  ACME   Services ')).toBe('ACME Services');
		expect(catalogLookupKey(' ACME   Services ')).toBe('acme services');
		expect(catalogKindLabel('paymentMethod')).toBe('Payment method');
		expect(catalogKindLabel('vendor')).toBe('Vendor');
		expect(catalogKindLabel('costCenter')).toBe('Cost center');
		expect(() => assertCatalogName('vendor', 'x')).toThrow();
		expect(() => assertCatalogName('paymentMethod', 'x'.repeat(81))).toThrow();
		expect(() => assertCatalogName('vendor', 'x'.repeat(121))).toThrow();
		expect(() => assertCatalogName('costCenter', 'bad\u0000name')).toThrow();
		expect(() => assertCatalogName('vendor', 'Valid vendor')).not.toThrow();

		const vendor = await createExpenseCatalogItem(fixture.context, {
			kind: 'vendor',
			name: 'Vendor one'
		});
		await expect(
			updateExpenseCatalogItem(fixture.context, {
				kind: 'vendor',
				id: vendor.id,
				name: 'Vendor renamed'
			})
		).resolves.toMatchObject({ id: vendor.id, name: 'Vendor renamed' });
		await expect(
			updateExpenseCatalogItem(fixture.context, {
				kind: 'costCenter',
				id: 2_147_483_647,
				name: 'Missing center'
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'paymentMethod', id: 2_147_483_647 })
		).rejects.toMatchObject({ status: 404 });
	});

	it('resolves active and explicitly retained archived catalog selections', async () => {
		const fixture = await createFixture();
		const vendor = await createExpenseCatalogItem(fixture.context, {
			kind: 'vendor',
			name: 'Archived vendor'
		});
		expect(
			await requireActiveCatalogItem(db, fixture.context.workspaceId, 'vendor', null)
		).toBeNull();
		expect(
			await resolveExpenseCatalogSelection(fixture.context.workspaceId, { vendorId: vendor.id })
		).toMatchObject({ vendorId: vendor.id, vendorName: 'Archived vendor' });
		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: vendor.id })
		).resolves.toMatchObject({ mode: 'deleted' });

		const usedVendor = await createExpenseCatalogItem(fixture.context, {
			kind: 'vendor',
			name: 'Used vendor'
		});
		await db.insert(expense).values({
			workspaceId: fixture.context.workspaceId,
			categoryId: fixture.categoryId,
			createdByUserId: fixture.context.userId,
			description: 'Vendor expense',
			amountCents: 100,
			expenseDate: '2026-07-01',
			vendorId: usedVendor.id,
			vendor: usedVendor.name
		});
		await removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: usedVendor.id });
		await expect(
			requireActiveCatalogItem(db, fixture.context.workspaceId, 'vendor', usedVendor.id)
		).rejects.toMatchObject({ status: 400 });
		expect(
			await requireActiveCatalogItem(db, fixture.context.workspaceId, 'vendor', usedVendor.id, true)
		).toMatchObject({ id: usedVendor.id, isArchived: true });
		expect(
			await resolveExpenseCatalogSelection(
				fixture.context.workspaceId,
				{ vendorId: usedVendor.id },
				{ allowedArchivedIds: { vendorId: usedVendor.id } }
			)
		).toMatchObject({ vendorId: usedVendor.id });
		await expect(
			getOrCreateCatalogItem(
				{ execute: async () => [] },
				fixture.context.workspaceId,
				'vendor',
				'No row'
			)
		).rejects.toMatchObject({ status: 500 });
		expect(await listExpenseCatalogs(fixture.context, true)).toMatchObject({
			vendors: [expect.objectContaining({ id: usedVendor.id, isArchived: true })]
		});
	});
});

async function createFixture() {
	const id = `catalog-${randomUUID()}`;
	await db
		.insert(user)
		.values({ id, name: 'Catalog owner', email: `${id}@example.com`, emailVerified: true });
	userIds.push(id);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Catalog ${randomUUID()}`, createdByUserId: id, currency: 'USD' })
		.returning({
			id: workspace.id,
			name: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn
		});
	workspaceIds.push(workspaceRow.id);
	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId: id,
		role: 'owner',
		status: 'active'
	});
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'Initial category', color: '#102030' })
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
