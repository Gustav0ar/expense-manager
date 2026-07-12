import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
	it('bounds active work and processes every item', async () => {
		let active = 0;
		let maximum = 0;
		const processed: number[] = [];
		await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
			active += 1;
			maximum = Math.max(maximum, active);
			await Promise.resolve();
			processed.push(item);
			active -= 1;
		});

		expect(maximum).toBe(2);
		expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it('normalizes invalid widths and accepts empty input', async () => {
		const processed: number[] = [];
		await mapWithConcurrency([1, 2], 0, async (item) => {
			processed.push(item);
		});
		await mapWithConcurrency([], 5, async () => {
			throw new Error('empty work should not run');
		});
		expect(processed).toEqual([1, 2]);
	});
});
