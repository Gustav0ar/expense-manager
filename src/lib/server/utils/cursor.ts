import { isValidIsoDate } from '$lib/server/validation';

type ExpenseCursor = {
	date: string;
	id: number;
};

export function encodeExpenseCursor(cursor: ExpenseCursor) {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeExpenseCursor(value: string | undefined) {
	if (!value) return null;

	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ExpenseCursor;
		if (
			typeof parsed.date !== 'string' ||
			!isValidIsoDate(parsed.date) ||
			typeof parsed.id !== 'number' ||
			!Number.isInteger(parsed.id) ||
			parsed.id < 0 ||
			!Number.isSafeInteger(parsed.id)
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}
