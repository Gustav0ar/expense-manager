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

	it('rejects malformed date strings', () => {
		// These used to pass through — now caught by isValidIsoDate
		const bad = (date: string) =>
			decodeExpenseCursor(Buffer.from(JSON.stringify({ date, id: 1 })).toString('base64url'));

		expect(bad('not-a-date')).toBeNull();
		expect(bad('9999-99-99')).toBeNull(); // invalid calendar date
		expect(bad('2026-13-01')).toBeNull(); // month 13
		expect(bad('2026-02-30')).toBeNull(); // Feb 30
		expect(bad("' OR 1=1--")).toBeNull(); // injection attempt
		expect(bad('2026-6-5')).toBeNull(); // not zero-padded
		expect(bad('20260605')).toBeNull(); // no separators
		expect(bad('2026/06/05')).toBeNull(); // wrong separators
	});

	it('accepts valid ISO dates at boundaries', () => {
		const ok = (date: string) =>
			decodeExpenseCursor(Buffer.from(JSON.stringify({ date, id: 1 })).toString('base64url'));

		expect(ok('2026-01-01')).not.toBeNull();
		expect(ok('2026-12-31')).not.toBeNull();
		expect(ok('2000-02-29')).not.toBeNull(); // 2000 is a leap year
	});

	it('rejects Feb 29 on non-leap years', () => {
		const bad = (date: string) =>
			decodeExpenseCursor(Buffer.from(JSON.stringify({ date, id: 1 })).toString('base64url'));

		expect(bad('2023-02-29')).toBeNull(); // 2023 is not a leap year
	});

	it('rejects non-numeric id and negative id', () => {
		const make = (date: string, id: unknown) =>
			decodeExpenseCursor(Buffer.from(JSON.stringify({ date, id })).toString('base64url'));

		expect(make('2026-06-25', -1)).toBeNull();
		expect(make('2026-06-25', 'abc')).toBeNull();
		expect(make('2026-06-25', null)).toBeNull();
	});
});
