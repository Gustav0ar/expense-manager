import { formatDateLabel } from './date-format';

export function formatCents(cents: number, currency = 'BRL') {
	return new Intl.NumberFormat('pt-BR', {
		style: 'currency',
		currency
	}).format(cents / 100);
}

export function formatPercent(value: number | null) {
	if (value == null) return 'Sem base';
	return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatDate(date: string, locales: Intl.LocalesArgument = undefined) {
	return formatDateLabel(date, locales);
}
