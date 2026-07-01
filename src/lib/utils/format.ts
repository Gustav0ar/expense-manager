import { formatDateLabel } from './date-format';
import {
	defaultCurrency,
	defaultLocale,
	formatCurrency,
	formatPercentage,
	translate,
	type MessageKey
} from '$lib/i18n';

export function formatCents(
	cents: number,
	currency = defaultCurrency,
	locales: Intl.LocalesArgument = defaultLocale
) {
	return formatCurrency(cents, locales, currency);
}

export function formatPercent(
	value: number | null,
	locales: Intl.LocalesArgument = defaultLocale,
	empty: MessageKey = 'No baseline'
) {
	const locale = Array.isArray(locales)
		? locales[0]
		: typeof locales === 'string'
			? locales
			: defaultLocale;
	return formatPercentage(value, locales, () => translate(locale, empty));
}

export function formatDate(date: string, locales: Intl.LocalesArgument = undefined) {
	return formatDateLabel(date, locales);
}
