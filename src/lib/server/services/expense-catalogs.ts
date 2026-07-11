import { error } from '@sveltejs/kit';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { canWriteExpenses } from '$lib/server/security/roles';
import type { WorkspaceContext } from './workspaces';
import { insertAuditEvent } from './audit';
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

	const item = await db.transaction(async (tx) => {
		const saved = await getOrCreateCatalogItem(
			tx,
			context.workspaceId,
			input.kind,
			input.name,
			context.locale
		);

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'expense_catalog.upserted',
			entityType: input.kind,
			entityId: saved.id,
			metadata: { name: saved.name }
		});

		return saved;
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
	assertCatalogName(input.kind, normalized, context.locale);

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
			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'expense_catalog.updated',
				entityType: input.kind,
				entityId: updated.id,
				metadata: { name: updated.name }
			});
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
			expenseCount > 0 || recurringCount > 0
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

		const result = {
			item: {
				...item,
				expenseCount,
				recurringCount
			},
			mode: expenseCount > 0 || recurringCount > 0 ? ('archived' as const) : ('deleted' as const)
		};

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: `expense_catalog.${result.mode}`,
			entityType: input.kind,
			entityId: result.item.id,
			metadata: {
				name: result.item.name,
				expenseCount: result.item.expenseCount,
				recurringCount: result.item.recurringCount
			}
		});

		return result;
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
	name: string,
	locale: string = 'en'
) {
	const normalized = normalizeCatalogName(name);
	assertCatalogName(kind, normalized, locale);

	const rows = await executeCatalogRows(executor, upsertCatalogSql(kind, workspaceId, normalized));
	const item = toCatalogItem(rows[0]);
	if (!item) throw error(500, translate(locale, 'Could not save the catalog.'));

	return item;
}

export function normalizeCatalogName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

export function catalogLookupKey(name: string) {
	return normalizeCatalogName(name).toLowerCase();
}

export function assertCatalogName(kind: ExpenseCatalogKind, name: string, locale: string = 'en') {
	const kindLabel = translate(locale, catalogKindLabel(kind));
	if (name.length < 2)
		throw error(
			400,
			translate(locale, '{kind} must be at least 2 characters.', { kind: kindLabel })
		);
	if (name.length > catalogNameMax(kind)) {
		throw error(
			400,
			translate(locale, '{kind} must be at most {count} characters.', {
				kind: kindLabel,
				count: catalogNameMax(kind)
			})
		);
	}
	if (hasControlCharacters(name)) {
		throw error(400, translate(locale, '{kind} contains invalid characters.', { kind: kindLabel }));
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
	const rows = await db.execute<CatalogRow>(
		paymentMethodUsageSql(workspaceId, { includeArchived })
	);

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
		left join expense e on e.workspace_id = v.workspace_id and e.vendor_id = v.id and e.deleted_at is null
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
		left join expense e on e.workspace_id = cc.workspace_id and e.cost_center_id = cc.id and e.deleted_at is null
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
		return paymentMethodUsageSql(workspaceId, { id });
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
			left join expense e on e.workspace_id = v.workspace_id and e.vendor_id = v.id and e.deleted_at is null
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
		left join expense e on e.workspace_id = cc.workspace_id and e.cost_center_id = cc.id and e.deleted_at is null
		where cc.workspace_id = ${workspaceId} and cc.id = ${id}
		group by cc.id, cc.name, cc.is_archived, cc.created_at
		limit 1
	`;
}

function paymentMethodUsageSql(
	workspaceId: number,
	options: { id?: number; includeArchived?: boolean } = {}
) {
	const paymentMethodIdFilter =
		options.id == null ? sql`` : sql`and payment_method_id = ${options.id}`;

	return sql`
		with expense_usage as (
			select payment_method_id, count(*)::int as expense_count
			from expense
			where workspace_id = ${workspaceId}
				and deleted_at is null
				and payment_method_id is not null
				${paymentMethodIdFilter}
			group by payment_method_id
		), recurring_usage as (
			select payment_method_id, count(*)::int as recurring_count
			from recurring_expense
			where workspace_id = ${workspaceId}
				and payment_method_id is not null
				${paymentMethodIdFilter}
			group by payment_method_id
		)
		select pm.id,
			pm.name,
			pm.is_archived,
			pm.created_at,
			coalesce(eu.expense_count, 0)::int as expense_count,
			coalesce(ru.recurring_count, 0)::int as recurring_count
		from payment_method pm
		left join expense_usage eu on eu.payment_method_id = pm.id
		left join recurring_usage ru on ru.payment_method_id = pm.id
		where pm.workspace_id = ${workspaceId}
			${options.id == null ? sql`` : sql`and pm.id = ${options.id}`}
			${options.id != null || options.includeArchived ? sql`` : sql`and pm.is_archived = false`}
		${options.id == null ? sql`order by pm.name asc, pm.id asc` : sql`limit 1`}
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
