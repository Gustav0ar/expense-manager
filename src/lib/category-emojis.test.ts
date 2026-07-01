import { describe, expect, it } from 'vitest';
import { categoryEmojiLabels, categoryEmojiValues } from './category-emojis';

describe('category emojis', () => {
	it('keeps every allowed emoji mapped to a business label', () => {
		expect(categoryEmojiValues.length).toBeGreaterThan(20);
		expect(new Set(categoryEmojiValues).size).toBe(categoryEmojiValues.length);

		for (const emoji of categoryEmojiValues) {
			expect(categoryEmojiLabels[emoji]).toMatch(/\S/);
		}
	});

	it('contains expected business-oriented categories', () => {
		expect(categoryEmojiLabels['🧾']).toBe('Accounting');
		expect(categoryEmojiLabels['👥']).toBe('Employees');
		expect(categoryEmojiLabels['🧰']).toBe('Supplies');
		expect(categoryEmojiLabels['🧼']).toBe('Cleaning');
	});
});
