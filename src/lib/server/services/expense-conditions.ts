import { and, eq, gte, ilike, isNull, lte, lt, or, type SQL } from 'drizzle-orm';
import { costCenter, expense, paymentMethod, vendor } from '$lib/server/db/schema';
import { decodeExpenseCursor } from '$lib/server/utils/cursor';
import type { ExpenseFilters } from './expenses';

export function buildExpenseConditions(
	workspaceId: number,
	filters: ExpenseFilters,
	includeCursor: boolean
): SQL[] {
	const conditions: SQL[] = [eq(expense.workspaceId, workspaceId), isNull(expense.deletedAt)];

	if (filters.from) conditions.push(gte(expense.expenseDate, filters.from));
	if (filters.to) conditions.push(lte(expense.expenseDate, filters.to));
	if (filters.categoryId) conditions.push(eq(expense.categoryId, filters.categoryId));
	if (filters.vendorId) conditions.push(eq(expense.vendorId, filters.vendorId));
	if (filters.costCenterId) conditions.push(eq(expense.costCenterId, filters.costCenterId));
	if (filters.competencyMonth)
		conditions.push(eq(expense.competencyMonth, filters.competencyMonth));
	if (filters.reviewStatus) conditions.push(eq(expense.reviewStatus, filters.reviewStatus));
	if (filters.paymentStatus) conditions.push(eq(expense.paymentStatus, filters.paymentStatus));
	if (filters.q) {
		const pattern = `%${filters.q}%`;
		conditions.push(
			or(
				ilike(expense.description, pattern),
				ilike(expense.vendor, pattern),
				ilike(expense.paymentMethod, pattern),
				ilike(expense.costCenter, pattern),
				ilike(vendor.name, pattern),
				ilike(paymentMethod.name, pattern),
				ilike(costCenter.name, pattern)
			)!
		);
	}

	const cursor = includeCursor ? decodeExpenseCursor(filters.cursor) : null;
	if (cursor) {
		conditions.push(
			or(
				lt(expense.expenseDate, cursor.date),
				and(eq(expense.expenseDate, cursor.date), lt(expense.id, cursor.id))
			)!
		);
	}

	return conditions;
}
