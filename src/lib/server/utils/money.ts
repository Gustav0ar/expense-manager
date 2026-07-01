import { defaultCurrency, defaultLocale, formatCurrency } from '$lib/i18n';

export function parseCurrencyToCents(input: string): number {
	const value = input.trim();
	if (!value) throw new Error('Amount is required.');

	const normalized = normalizeCurrencyInput(value);

	if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
		throw new Error('Amount is invalid.');
	}

	const numberValue = Number(normalized);
	if (!Number.isFinite(numberValue) || numberValue <= 0) {
		throw new Error('Amount must be greater than zero.');
	}

	return Math.round(numberValue * 100);
}

export function parseBrlToCents(input: string): number {
	return parseCurrencyToCents(input);
}

export function formatCents(
	cents: number,
	currency = defaultCurrency,
	locales: Intl.LocalesArgument = defaultLocale
) {
	return formatCurrency(cents, locales, currency);
}

function normalizeCurrencyInput(value: string) {
	const sanitized = value.replace(/[^\d,.-]/g, '');
	const sign = sanitized.startsWith('-') ? '-' : '';
	const unsigned = sanitized.replace(/-/g, '');
	const commaIndex = unsigned.lastIndexOf(',');
	const dotIndex = unsigned.lastIndexOf('.');

	if (commaIndex !== -1 && dotIndex !== -1) {
		const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
		const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
		return `${sign}${unsigned.replaceAll(thousandsSeparator, '').replace(decimalSeparator, '.')}`;
	}

	const separator = commaIndex !== -1 ? ',' : dotIndex !== -1 ? '.' : null;
	if (!separator) return `${sign}${unsigned}`;

	const parts = unsigned.split(separator);
	if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) {
		return `${sign}${parts[0]}.${parts[1]}`;
	}

	if (parts.length >= 2 && parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
		return `${sign}${parts.join('')}`;
	}

	return `${sign}${unsigned}`;
}
