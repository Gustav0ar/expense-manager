import { describe, expect, it } from 'vitest';
import { decodeExpenseCursor, encodeExpenseCursor } from './cursor';

describe('expense cursor', () => {
	it('round-trips a cursor', () => {
		const cursor = { date: '2026-06-25', id: 42 };
		expect(decodeExpenseCursor(encodeExpenseCursor(cursor))).toEqual(cursor);
	});

	it('returns null for invalid cursors', () => {
		expect(decodeExpenseCursor('bad')).toBeNull();
		expect(decodeExpenseCursor(undefined)).toBeNull();
		expect(
			decodeExpenseCursor(Buffer.from(JSON.stringify({ date: '', id: 42 })).toString('base64url'))
		).toBeNull();
		expect(
			decodeExpenseCursor(
				Buffer.from(JSON.stringify({ date: '2026-06-25', id: 4.2 })).toString('base64url')
			)
		).toBeNull();
	});
});
