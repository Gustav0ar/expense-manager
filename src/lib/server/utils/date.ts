const isoDateFormatter = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'UTC',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

export function todayIso(date = new Date()) {
	return isoDateFormatter.format(date);
}

export function firstDayOfMonth(date = new Date()) {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	return isoDateFormatter.format(new Date(Date.UTC(year, month, 1)));
}

export function lastDayOfMonth(date = new Date()) {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	return isoDateFormatter.format(new Date(Date.UTC(year, month + 1, 0)));
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
