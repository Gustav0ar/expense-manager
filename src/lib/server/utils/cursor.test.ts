import { describe, expect, it } from 'vitest';
import {
	decodeCursor,
	decodeExpenseCursor,
	encodeCursor,
	encodeExpenseCursor,
	isSafePositiveInteger,
	maxEncodedCursorLength
} from './cursor';

const isIdCursor = (value: unknown): value is { id: number } => {
	const candidate = value && typeof value === 'object' ? (value as { id?: unknown }) : null;
	return Boolean(candidate && isSafePositiveInteger(candidate.id));
};

describe('shared cursor codec', () => {
	it('round-trips a validated payload', () => {
		expect(decodeCursor(encodeCursor({ id: 42 }), isIdCursor)).toEqual({ id: 42 });
	});

	it('rejects oversized, malformed, and unsafe numeric payloads', () => {
		expect(decodeCursor('x'.repeat(maxEncodedCursorLength + 1), isIdCursor)).toBeNull();
		expect(decodeCursor('not-a-cursor', isIdCursor)).toBeNull();
		expect(decodeCursor(encodeCursor({ id: Number.MAX_SAFE_INTEGER + 1 }), isIdCursor)).toBeNull();
		expect(decodeCursor(encodeCursor({ id: 0 }), isIdCursor)).toBeNull();
	});
});

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
