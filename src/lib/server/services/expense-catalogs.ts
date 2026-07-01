import { error } from '@sveltejs/kit';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { canWriteExpenses } from '$lib/server/security/roles';
import type { WorkspaceContext } from './workspaces';
import { writeAuditEvent } from './audit';
import { translate } from '$lib/i18n';

export type ExpenseCatalogKind = 'paymentMethod' | 'vendor' | 'costCenter';

export type ExpenseCatalogItem = {
	id: number;
	name: string;
	isArchived: boolean;
	expenseCount: number;
	recurringCount: number;
	createdAt?: Date;
};

type CatalogExecutor = {
	execute(query: SQL): PromiseLike<unknown>;
};

type CatalogRow = {
	id: number | string;
	name: string;
	is_archived?: boolean;
	expense_count?: number | string;
	recurring_count?: number | string;
	created_at?: Date;
};

type CatalogSelectionOptions = {
	allowArchived?: boolean;
	locale?: string;
	allowedArchivedIds?: {
		paymentMethodId?: number | null;
		vendorId?: number | null;
		costCenterId?: number | null;
	};
};

export async function listExpenseCatalogs(context: WorkspaceContext, includeArchived = false) {
	const [paymentMethods, vendors, costCenters] = await Promise.all([
		listPaymentMethods(context.workspaceId, includeArchived),
		listVendors(context.workspaceId, includeArchived),
		listCostCenters(context.workspaceId, includeArchived)
	]);

	return { paymentMethods, vendors, costCenters };
}

export async function createExpenseCatalogItem(
	context: WorkspaceContext,
	input: { kind: ExpenseCatalogKind; name: string }
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const item = await getOrCreateCatalogItem(db, context.workspaceId, input.kind, input.name);

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'expense_catalog.upserted',
		entityType: input.kind,
		entityId: item.id,
		metadata: { name: item.name }
	});

	return item;
}

export async function updateExpenseCatalogItem(
	context: WorkspaceContext,
	input: { kind: ExpenseCatalogKind; id: number; name: string }
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const normalized = normalizeCatalogName(input.name);
	assertCatalogName(input.kind, normalized);

	const item = await db.transaction(async (tx) => {
		try {
			const rows = await executeCatalogRows(
				tx,
				updateCatalogSql(input.kind, context.workspaceId, input.id, normalized)
			);
			const updated = toCatalogItem(rows[0]);
			if (!updated)
				throw error(
					404,
					translate(context.locale, '{kind} not found.', {
						kind: translate(context.locale, catalogKindLabel(input.kind))
					})
				);

			await tx.execute(syncCatalogNameSql(input.kind, context.workspaceId, input.id, normalized));
			return updated;
		} catch (catalogError) {
			if (isUniqueViolation(catalogError)) {
				throw error(
					400,
					translate(context.locale, '{kind} already exists.', {
						kind: translate(context.locale, catalogKindLabel(input.kind))
					})
				);
			}
			throw catalogError;
		}
	});

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'expense_catalog.updated',
		entityType: input.kind,
		entityId: item.id,
		metadata: { name: item.name }
	});

	return item;
}

export async function removeExpenseCatalogItem(
	context: WorkspaceContext,
	input: { kind: ExpenseCatalogKind; id: number }
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const removed = await db.transaction(async (tx) => {
		const [usage] = await executeCatalogRows(
			tx,
			selectCatalogUsageSql(input.kind, context.workspaceId, input.id)
		);
		if (!usage)
			throw error(
				404,
				translate(context.locale, '{kind} not found.', {
					kind: translate(context.locale, catalogKindLabel(input.kind))
				})
			);

		const expenseCount = Number(usage.expense_count ?? 0);
		const recurringCount = Number(usage.recurring_count ?? 0);
		const rows = await executeCatalogRows(
			tx,
			expenseCount > 0
				? archiveCatalogSql(input.kind, context.workspaceId, input.id)
				: deleteCatalogSql(input.kind, context.workspaceId, input.id)
		);
		const item = toCatalogItem(rows[0]);
		if (!item)
			throw error(
				404,
				translate(context.locale, '{kind} not found.', {
					kind: translate(context.locale, catalogKindLabel(input.kind))
				})
			);

		return {
			item: {
				...item,
				expenseCount,
				recurringCount
			},
			mode: expenseCount > 0 ? ('archived' as const) : ('deleted' as const)
		};
	});

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: `expense_catalog.${removed.mode}`,
		entityType: input.kind,
		entityId: removed.item.id,
		metadata: {
			name: removed.item.name,
			expenseCount: removed.item.expenseCount,
			recurringCount: removed.item.recurringCount
		}
	});

	return removed;
}

export async function resolveExpenseCatalogSelection(
	workspaceId: number,
	input: {
		paymentMethodId?: number | null;
		vendorId?: number | null;
		costCenterId?: number | null;
	},
	options: CatalogSelectionOptions = {}
) {
	const [resolvedPaymentMethod, resolvedVendor, resolvedCostCenter] = await Promise.all([
		requireActiveCatalogItem(
			db,
			workspaceId,
			'paymentMethod',
			input.paymentMethodId,
			canUseArchivedCatalog(input.paymentMethodId, options.allowedArchivedIds?.paymentMethodId) ||
				options.allowArchived,
			options.locale
		),
		requireActiveCatalogItem(
			db,
			workspaceId,
			'vendor',
			input.vendorId,
			canUseArchivedCatalog(input.vendorId, options.allowedArchivedIds?.vendorId) ||
				options.allowArchived,
			options.locale
		),
		requireActiveCatalogItem(
			db,
			workspaceId,
			'costCenter',
			input.costCenterId,
			canUseArchivedCatalog(input.costCenterId, options.allowedArchivedIds?.costCenterId) ||
				options.allowArchived,
			options.locale
		)
	]);

	return {
		paymentMethodId: resolvedPaymentMethod?.id ?? null,
		paymentMethodName: resolvedPaymentMethod?.name ?? null,
		vendorId: resolvedVendor?.id ?? null,
		vendorName: resolvedVendor?.name ?? null,
		costCenterId: resolvedCostCenter?.id ?? null,
		costCenterName: resolvedCostCenter?.name ?? null
	};
}

export async function requireActiveCatalogItem(
	executor: CatalogExecutor,
	workspaceId: number,
	kind: ExpenseCatalogKind,
	id?: number | null,
	allowArchived = false,
	locale = 'en'
) {
	if (!id) return null;

	const rows = await executeCatalogRows(executor, selectCatalogByIdSql(kind, workspaceId, id));
	const item = toCatalogItem(rows[0]);
	if (!item || (!allowArchived && item.isArchived))
		throw error(
			400,
			translate(locale, '{kind} is invalid.', { kind: translate(locale, catalogKindLabel(kind)) })
		);

	return item;
}

export async function getOrCreateCatalogItem(
	executor: CatalogExecutor,
	workspaceId: number,
	kind: ExpenseCatalogKind,
	name: string
) {
	const normalized = normalizeCatalogName(name);
	assertCatalogName(kind, normalized);

	const rows = await executeCatalogRows(executor, upsertCatalogSql(kind, workspaceId, normalized));
	const item = toCatalogItem(rows[0]);
	if (!item) throw error(500, 'Could not save the catalog.');

	return item;
}

export function normalizeCatalogName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

export function catalogLookupKey(name: string) {
	return normalizeCatalogName(name).toLowerCase();
}

export function assertCatalogName(kind: ExpenseCatalogKind, name: string) {
	if (name.length < 2) throw error(400, `${catalogKindLabel(kind)} must be at least 2 characters.`);
	if (name.length > catalogNameMax(kind)) {
		throw error(
			400,
			`${catalogKindLabel(kind)} must be at most ${catalogNameMax(kind)} characters.`
		);
	}
	if (hasControlCharacters(name)) {
		throw error(400, `${catalogKindLabel(kind)} contains invalid characters.`);
	}
}

export function catalogKindLabel(kind: ExpenseCatalogKind) {
	if (kind === 'paymentMethod') return 'Payment method';
	if (kind === 'vendor') return 'Vendor';
	return 'Cost center';
}

function catalogNameMax(kind: ExpenseCatalogKind) {
	return kind === 'paymentMethod' ? 80 : 120;
}

function canUseArchivedCatalog(id?: number | null, allowedId?: number | null) {
	return Boolean(id && allowedId && id === allowedId);
}

async function listPaymentMethods(workspaceId: number, includeArchived: boolean) {
	const rows = await db.execute<CatalogRow>(sql`
		select pm.id,
			pm.name,
			pm.is_archived,
			pm.created_at,
			count(distinct e.id)::int as expense_count,
			count(distinct re.id)::int as recurring_count
		from payment_method pm
		left join expense e on e.workspace_id = pm.workspace_id and e.payment_method_id = pm.id
		left join recurring_expense re on re.workspace_id = pm.workspace_id and re.payment_method_id = pm.id
		where pm.workspace_id = ${workspaceId}
			${includeArchived ? sql`` : sql`and pm.is_archived = false`}
		group by pm.id, pm.name, pm.is_archived, pm.created_at
		order by pm.name asc, pm.id asc
	`);

	return rows.map((row) => toCatalogItem(row)!);
}

async function listVendors(workspaceId: number, includeArchived: boolean) {
	const rows = await db.execute<CatalogRow>(sql`
		select v.id,
			v.name,
			v.is_archived,
			v.created_at,
			count(distinct e.id)::int as expense_count,
			0::int as recurring_count
		from vendor v
		left join expense e on e.workspace_id = v.workspace_id and e.vendor_id = v.id
		where v.workspace_id = ${workspaceId}
			${includeArchived ? sql`` : sql`and v.is_archived = false`}
		group by v.id, v.name, v.is_archived, v.created_at
		order by v.name asc, v.id asc
	`);

	return rows.map((row) => toCatalogItem(row)!);
}

async function listCostCenters(workspaceId: number, includeArchived: boolean) {
	const rows = await db.execute<CatalogRow>(sql`
		select cc.id,
			cc.name,
			cc.is_archived,
			cc.created_at,
			count(distinct e.id)::int as expense_count,
			0::int as recurring_count
		from cost_center cc
		left join expense e on e.workspace_id = cc.workspace_id and e.cost_center_id = cc.id
		where cc.workspace_id = ${workspaceId}
			${includeArchived ? sql`` : sql`and cc.is_archived = false`}
		group by cc.id, cc.name, cc.is_archived, cc.created_at
		order by cc.name asc, cc.id asc
	`);

	return rows.map((row) => toCatalogItem(row)!);
}

function toCatalogItem(row?: CatalogRow): ExpenseCatalogItem | null {
	if (!row) return null;

	return {
		id: Number(row.id),
		name: row.name,
		isArchived: Boolean(row.is_archived),
		expenseCount: Number(row.expense_count ?? 0),
		recurringCount: Number(row.recurring_count ?? 0),
		createdAt: row.created_at
	};
}

async function executeCatalogRows(executor: CatalogExecutor, query: SQL) {
	return (await executor.execute(query)) as CatalogRow[];
}

function hasControlCharacters(value: string) {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function selectCatalogByIdSql(kind: ExpenseCatalogKind, workspaceId: number, id: number) {
	if (kind === 'paymentMethod') {
		return sql`
			select id, name, is_archived, created_at
			from payment_method
			where workspace_id = ${workspaceId} and id = ${id}
			limit 1
		`;
	}

	if (kind === 'vendor') {
		return sql`
			select id, name, is_archived, created_at
			from vendor
			where workspace_id = ${workspaceId} and id = ${id}
			limit 1
		`;
	}

	return sql`
		select id, name, is_archived, created_at
		from cost_center
		where workspace_id = ${workspaceId} and id = ${id}
		limit 1
	`;
}

function upsertCatalogSql(kind: ExpenseCatalogKind, workspaceId: number, name: string) {
	if (kind === 'paymentMethod') {
		return sql`
			insert into payment_method (workspace_id, name, is_archived)
			values (${workspaceId}, ${name}, false)
			on conflict (workspace_id, lower(name))
			do update set name = excluded.name, is_archived = false, updated_at = now()
			returning id, name, is_archived, created_at
		`;
	}

	if (kind === 'vendor') {
		return sql`
			insert into vendor (workspace_id, name, is_archived)
			values (${workspaceId}, ${name}, false)
			on conflict (workspace_id, lower(name))
			do update set name = excluded.name, is_archived = false, updated_at = now()
			returning id, name, is_archived, created_at
		`;
	}

	return sql`
		insert into cost_center (workspace_id, name, is_archived)
		values (${workspaceId}, ${name}, false)
		on conflict (workspace_id, lower(name))
		do update set name = excluded.name, is_archived = false, updated_at = now()
		returning id, name, is_archived, created_at
	`;
}

function updateCatalogSql(kind: ExpenseCatalogKind, workspaceId: number, id: number, name: string) {
	if (kind === 'paymentMethod') {
		return sql`
			update payment_method
			set name = ${name}, is_archived = false, updated_at = now()
			where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
			returning id, name, is_archived, created_at
		`;
	}

	if (kind === 'vendor') {
		return sql`
			update vendor
			set name = ${name}, is_archived = false, updated_at = now()
			where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
			returning id, name, is_archived, created_at
		`;
	}

	return sql`
		update cost_center
		set name = ${name}, is_archived = false, updated_at = now()
		where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
		returning id, name, is_archived, created_at
	`;
}

function syncCatalogNameSql(
	kind: ExpenseCatalogKind,
	workspaceId: number,
	id: number,
	name: string
) {
	if (kind === 'paymentMethod') {
		return sql`
			with updated_expense as (
				update expense
				set payment_method = ${name}
				where workspace_id = ${workspaceId} and payment_method_id = ${id}
				returning 1
			)
			update recurring_expense
			set payment_method = ${name}
			where workspace_id = ${workspaceId} and payment_method_id = ${id}
		`;
	}

	if (kind === 'vendor') {
		return sql`
			update expense
			set vendor = ${name}
			where workspace_id = ${workspaceId} and vendor_id = ${id}
		`;
	}

	return sql`
		update expense
		set cost_center = ${name}
		where workspace_id = ${workspaceId} and cost_center_id = ${id}
	`;
}

function archiveCatalogSql(kind: ExpenseCatalogKind, workspaceId: number, id: number) {
	if (kind === 'paymentMethod') {
		return sql`
			update payment_method
			set is_archived = true, updated_at = now()
			where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
			returning id, name, is_archived, created_at
		`;
	}

	if (kind === 'vendor') {
		return sql`
			update vendor
			set is_archived = true, updated_at = now()
			where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
			returning id, name, is_archived, created_at
		`;
	}

	return sql`
		update cost_center
		set is_archived = true, updated_at = now()
		where workspace_id = ${workspaceId} and id = ${id} and is_archived = false
		returning id, name, is_archived, created_at
	`;
}

function deleteCatalogSql(kind: ExpenseCatalogKind, workspaceId: number, id: number) {
	if (kind === 'paymentMethod') {
		return sql`
			delete from payment_method
			where workspace_id = ${workspaceId} and id = ${id}
			returning id, name, is_archived, created_at
		`;
	}

	if (kind === 'vendor') {
		return sql`
			delete from vendor
			where workspace_id = ${workspaceId} and id = ${id}
			returning id, name, is_archived, created_at
		`;
	}

	return sql`
		delete from cost_center
		where workspace_id = ${workspaceId} and id = ${id}
		returning id, name, is_archived, created_at
	`;
}

function selectCatalogUsageSql(kind: ExpenseCatalogKind, workspaceId: number, id: number) {
	if (kind === 'paymentMethod') {
		return sql`
			select pm.id,
				pm.name,
				pm.is_archived,
				pm.created_at,
				count(distinct e.id)::int as expense_count,
				count(distinct re.id)::int as recurring_count
			from payment_method pm
			left join expense e on e.workspace_id = pm.workspace_id and e.payment_method_id = pm.id
			left join recurring_expense re on re.workspace_id = pm.workspace_id and re.payment_method_id = pm.id
			where pm.workspace_id = ${workspaceId} and pm.id = ${id}
			group by pm.id, pm.name, pm.is_archived, pm.created_at
			limit 1
		`;
	}

	if (kind === 'vendor') {
		return sql`
			select v.id,
				v.name,
				v.is_archived,
				v.created_at,
				count(distinct e.id)::int as expense_count,
				0::int as recurring_count
			from vendor v
			left join expense e on e.workspace_id = v.workspace_id and e.vendor_id = v.id
			where v.workspace_id = ${workspaceId} and v.id = ${id}
			group by v.id, v.name, v.is_archived, v.created_at
			limit 1
		`;
	}

	return sql`
		select cc.id,
			cc.name,
			cc.is_archived,
			cc.created_at,
			count(distinct e.id)::int as expense_count,
			0::int as recurring_count
		from cost_center cc
		left join expense e on e.workspace_id = cc.workspace_id and e.cost_center_id = cc.id
		where cc.workspace_id = ${workspaceId} and cc.id = ${id}
		group by cc.id, cc.name, cc.is_archived, cc.created_at
		limit 1
	`;
}

function isUniqueViolation(catalogError: unknown) {
	if (typeof catalogError !== 'object' || catalogError == null) return false;
	const directCode = 'code' in catalogError ? catalogError.code : null;
	const cause =
		'cause' in catalogError && typeof catalogError.cause === 'object' && catalogError.cause != null
			? catalogError.cause
			: null;
	const causeCode = cause && 'code' in cause ? cause.code : null;

	return directCode === '23505' || causeCode === '23505';
}
