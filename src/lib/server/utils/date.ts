const isoDateFormatter = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'UTC',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

export function todayIso(timeZone = 'UTC', date = new Date()) {
	return formatDateInTimeZone(date, timeZone);
}

export function firstDayOfMonth(date = new Date(), timeZone = 'UTC') {
	const { year, month } = getDatePartsInTimeZone(date, timeZone);
	return isoDateFormatter.format(new Date(Date.UTC(year, month - 1, 1)));
}

export function lastDayOfMonth(date = new Date(), timeZone = 'UTC') {
	const { year, month } = getDatePartsInTimeZone(date, timeZone);
	return isoDateFormatter.format(new Date(Date.UTC(year, month, 0)));
}

export function addDays(date: string, days: number) {
	const [year, month, day] = date.split('-').map(Number);
	const value = new Date(Date.UTC(year, month - 1, day + days));
	return isoDateFormatter.format(value);
}

export function addMonths(date: string, months: number) {
	const [year, month, day] = date.split('-').map(Number);
	const target = new Date(Date.UTC(year, month - 1 + months, 1));
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
	).getUTCDate();
	target.setUTCDate(Math.min(day, lastDay));
	return isoDateFormatter.format(target);
}

export function addYears(date: string, years: number) {
	return addMonths(date, years * 12);
}

export function startOfMonth(date: string) {
	const [year, month] = date.split('-').map(Number);
	return isoDateFormatter.format(new Date(Date.UTC(year, month - 1, 1)));
}

export function advanceDate(
	date: string,
	frequency: 'weekly' | 'monthly' | 'yearly',
	intervalCount: number
) {
	if (frequency === 'weekly') return addDays(date, intervalCount * 7);
	if (frequency === 'yearly') return addYears(date, intervalCount);
	return addMonths(date, intervalCount);
}

export function previousPeriod(from: string, to: string) {
	const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
	const [toYear, toMonth, toDay] = to.split('-').map(Number);
	const start = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));
	const end = new Date(Date.UTC(toYear, toMonth - 1, toDay));
	const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
	const previousTo = addDays(from, -1);
	const previousFrom = addDays(previousTo, -(days - 1));
	return { from: previousFrom, to: previousTo };
}

function formatDateInTimeZone(date: Date, timeZone: string) {
	const { year, month, day } = getDatePartsInTimeZone(date, timeZone);
	return isoDateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

function getDatePartsInTimeZone(date: Date, timeZone: string) {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: validTimeZone(timeZone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	const parts = Object.fromEntries(
		formatter
			.formatToParts(date)
			.filter((part) => part.type !== 'literal')
			.map((part) => [part.type, Number(part.value)])
	);

	return {
		year: parts.year,
		month: parts.month,
		day: parts.day
	};
}

function validTimeZone(timeZone: string) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return timeZone;
	} catch {
		return 'UTC';
	}
}
