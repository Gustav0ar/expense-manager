import { describe, expect, it } from 'vitest';
import {
	chunkImportValues,
	classifyImportExpenseRows,
	importCatalogUpsertChunkSize,
	importDuplicateLookupChunkSize,
	importExpenseIdentityKey,
	importInsertChunkSize,
	uniqueImportExpenseIdentities,
	type ImportExpenseIdentity
} from './import-batching';

function identity(
	description: string,
	overrides: Partial<ImportExpenseIdentity> = {}
): ImportExpenseIdentity {
	return {
		amountCents: 1_000,
		expenseDate: '2026-07-11',
		description,
		...overrides
	};
}

describe('import batching', () => {
	it('compares the exact amount, date, and description triple', () => {
		const base = identity('Same | delimiters');
		const existing = [base];
		const rows = [
			base,
			identity('Same | delimiters', { amountCents: 1_001 }),
			identity('Same | delimiters', { expenseDate: '2026-07-12' }),
			identity('Different')
		];

		expect(classifyImportExpenseRows(rows, existing)).toEqual({
			acceptedRows: rows.slice(1),
			duplicateCount: 1
		});
		expect(importExpenseIdentityKey(base)).not.toBe(
			importExpenseIdentityKey(identity('Same', { expenseDate: '2026-07-11|Same' }))
		);
	});

	it('preserves identical rows within a new batch', () => {
		const repeated = identity('Two coffees');

		expect(classifyImportExpenseRows([repeated, repeated], [])).toEqual({
			acceptedRows: [repeated, repeated],
			duplicateCount: 0
		});
	});

	it('skips every occurrence when the exact row existed before the import', () => {
		const repeated = identity('Already imported');

		expect(classifyImportExpenseRows([repeated, repeated], [repeated])).toEqual({
			acceptedRows: [],
			duplicateCount: 2
		});
	});

	it('deduplicates lookup identities without deduplicating accepted rows', () => {
		const repeated = identity('Repeated');
		const distinct = identity('Distinct');

		expect(uniqueImportExpenseIdentities([repeated, repeated, distinct])).toEqual([
			repeated,
			distinct
		]);
	});

	it('bounds duplicate lookup and insert chunks for the 500-row limit', () => {
		const rows = Array.from({ length: 500 }, (_, index) => identity(`Expense ${index}`));

		expect(chunkImportValues(rows, importDuplicateLookupChunkSize)).toHaveLength(5);
		expect(chunkImportValues(rows, importInsertChunkSize)).toHaveLength(5);
		expect(chunkImportValues(rows, importCatalogUpsertChunkSize)).toHaveLength(5);
		expect(
			chunkImportValues(rows, importDuplicateLookupChunkSize).every((chunk) => chunk.length <= 100)
		).toBe(true);
	});

	it('rejects invalid chunk sizes', () => {
		expect(() => chunkImportValues([1], 0)).toThrow(RangeError);
		expect(() => chunkImportValues([1], 1.5)).toThrow(RangeError);
	});
});
