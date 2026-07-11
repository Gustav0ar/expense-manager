import { describe, expect, it } from 'vitest';
import { analyzeExpenseImport } from './imports';

describe('import analysis', () => {
	it('normalizes stable rows and groups duplicates and validation failures without writes', () => {
		const result = analyzeExpenseImport({
			sourceType: 'csv',
			parsed: {
				rows: [
					{
						rowNumber: 2,
						expenseDate: '2026-07-11',
						description: 'Known purchase',
						amount: '10.00',
						categoryName: 'Operations'
					},
					{
						rowNumber: 3,
						expenseDate: '2026-07-11',
						description: 'Unmapped purchase',
						amount: '20.00'
					}
				],
				errors: ['Malformed source row']
			},
			categories: [{ id: 7, name: 'Operations', isArchived: false }],
			rules: [],
			existingRows: [
				{ expenseDate: '2026-07-11', description: 'Known purchase', amountCents: 1000 }
			]
		});

		expect(result.rows).toEqual([
			expect.objectContaining({
				sourceRowId: 'csv:2',
				amountCents: 1000,
				categoryId: 7,
				categoryName: 'Operations',
				isDuplicate: true
			})
		]);
		expect(result.failedRows).toEqual([
			{ rowNumber: 0, message: 'Malformed source row' },
			{
				rowNumber: 3,
				message: 'Category not found and no default category was selected.'
			}
		]);
	});
});
