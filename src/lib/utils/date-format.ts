export type DatePeriod = 'date' | 'week' | 'month' | 'year';
export type DateLabelWidth = 'full' | 'compact';

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getBrowserLocales(): Intl.LocalesArgument {
	if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
	return navigator.languages?.length ? navigator.languages : navigator.language;
}

export function parseIsoDate(value: string) {
	const match = isoDatePattern.exec(value);
	if (!match) return null;

	const [, year, month, day] = match;
	const yearNumber = Number(year);
	const monthNumber = Number(month);
	const dayNumber = Number(day);
	const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
	if (
		Number.isNaN(date.getTime()) ||
		date.getUTCFullYear() !== yearNumber ||
		date.getUTCMonth() !== monthNumber - 1 ||
		date.getUTCDate() !== dayNumber
	) {
		return null;
	}

	return date;
}

export function formatDateLabel(
	value: string,
	locales: Intl.LocalesArgument = undefined,
	width: DateLabelWidth = 'full'
) {
	const date = parseIsoDate(value);
	if (!date) return value;

	return new Intl.DateTimeFormat(locales, {
		timeZone: 'UTC',
		day: '2-digit',
		month: '2-digit',
		year: width === 'full' ? 'numeric' : undefined
	}).format(date);
}

export function formatMonthLabel(
	value: string,
	locales: Intl.LocalesArgument = undefined,
	width: DateLabelWidth = 'full'
) {
	const date = parseIsoDate(value);
	if (!date) return value;

	return new Intl.DateTimeFormat(locales, {
		timeZone: 'UTC',
		month: width === 'full' ? 'short' : '2-digit',
		year: width === 'full' ? 'numeric' : '2-digit'
	}).format(date);
}

export function formatYearLabel(value: string, locales: Intl.LocalesArgument = undefined) {
	const date = parseIsoDate(value);
	if (!date) return value;

	return new Intl.DateTimeFormat(locales, {
		timeZone: 'UTC',
		year: 'numeric'
	}).format(date);
}

export function formatPeriodLabel(
	value: string,
	period: DatePeriod,
	locales: Intl.LocalesArgument = undefined,
	width: DateLabelWidth = 'full'
) {
	if (period === 'month') return formatMonthLabel(value, locales, width);
	if (period === 'year') return formatYearLabel(value, locales);
	return formatDateLabel(value, locales, width);
}

export function formatDateRangeLabel(
	from: string,
	to: string,
	locales: Intl.LocalesArgument = undefined
) {
	const fromDate = parseIsoDate(from);
	const toDate = parseIsoDate(to);
	if (!fromDate || !toDate) return `${from} a ${to}`;

	const formatter = new Intl.DateTimeFormat(locales, {
		timeZone: 'UTC',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric'
	});

	if (typeof formatter.formatRange === 'function') {
		return formatter.formatRange(fromDate, toDate);
	}

	return `${formatter.format(fromDate)} a ${formatter.format(toDate)}`;
}

export function formatDateTimeLabel(
	value: Date | string,
	locales: Intl.LocalesArgument = undefined,
	width: DateLabelWidth = 'full'
) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);

	return new Intl.DateTimeFormat(locales, {
		dateStyle: width === 'full' ? 'medium' : 'short',
		timeStyle: 'short'
	}).format(date);
}

export function formatDatePart(
	value: string,
	part: 'day' | 'month',
	locales: Intl.LocalesArgument = undefined
) {
	const date = parseIsoDate(value);
	if (!date) return value;

	return new Intl.DateTimeFormat(locales, {
		timeZone: 'UTC',
		day: part === 'day' ? '2-digit' : undefined,
		month: part === 'month' ? 'short' : undefined
	}).format(date);
}
