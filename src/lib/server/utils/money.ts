import { defaultCurrency, defaultLocale, formatCurrency } from '$lib/i18n';

export function parseCurrencyToCents(input: string): number {
	const value = input.trim();
	if (!value) throw new Error('Amount is required.');

	const normalized = normalizeCurrencyInput(value);

	if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
		throw new Error('Amount is invalid.');
	}

	const isNegative = normalized.startsWith('-');
	const unsigned = normalized.replace(/^-/, '');
	const dotIdx = unsigned.indexOf('.');
	const intStr = dotIdx === -1 ? unsigned : unsigned.slice(0, dotIdx);
	const fracStr = dotIdx === -1 ? '' : unsigned.slice(dotIdx + 1);
	const cents =
		parseInt(intStr || '0', 10) * 100 + parseInt(fracStr.padEnd(2, '0').slice(0, 2), 10);
	if (isNegative || cents <= 0) throw new Error('Amount must be greater than zero.');
	return cents;
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
