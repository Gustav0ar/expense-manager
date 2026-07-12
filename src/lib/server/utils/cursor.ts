import { isValidIsoDate } from '$lib/server/validation';

type ExpenseCursor = {
	date: string;
	id: number;
};

export const maxEncodedCursorLength = 256;

export function encodeCursor(cursor: object) {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor<T>(
	value: string | undefined,
	isValid: (value: unknown) => value is T
) {
	if (!value || value.length > maxEncodedCursorLength) return null;

	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
		return isValid(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function encodeExpenseCursor(cursor: ExpenseCursor) {
	return encodeCursor(cursor);
}

export function decodeExpenseCursor(value: string | undefined) {
	return decodeCursor(value, isExpenseCursor);
}

function isExpenseCursor(value: unknown): value is ExpenseCursor {
	if (!value || typeof value !== 'object') return false;
	const cursor = value as Partial<ExpenseCursor>;
	return (
		typeof cursor.date === 'string' &&
		isValidIsoDate(cursor.date) &&
		isSafePositiveInteger(cursor.id)
	);
}
