import { ptBrMessages } from './messages';

export const defaultLocale = 'en';
export const supportedLocales = ['en', 'pt-BR'] as const;
export const localePreferences = ['system', ...supportedLocales] as const;
export const defaultCurrency = 'USD';

export type SupportedLocale = (typeof supportedLocales)[number];
export type LocalePreference = (typeof localePreferences)[number];
export type MessageKey = keyof typeof ptBrMessages | (string & {});

const dictionaries: Record<SupportedLocale, Partial<Record<string, string>>> = {
	en: {
		'Home short': 'Home',
		'Expenses short': 'Exp.',
		'Budget short': 'Budget',
		'Reports short': 'Rep.',
		'Settings short': 'Config',
		Budget: 'Budget'
	},
	'pt-BR': ptBrMessages
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
	return typeof value === 'string' && supportedLocales.includes(value as SupportedLocale);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
	return typeof value === 'string' && localePreferences.includes(value as LocalePreference);
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
	if (!value) return null;
	const normalized = value.trim().replace('_', '-').toLowerCase();
	if (!normalized) return null;
	if (normalized === 'pt' || normalized === 'pt-br') return 'pt-BR';
	if (normalized.startsWith('pt-')) return 'pt-BR';
	if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
	return null;
}

export function resolveLocale(
	preference: LocalePreference | null | undefined,
	acceptLanguage: string | null | undefined
): SupportedLocale {
	if (preference && preference !== 'system') return preference;
	return negotiateLocale(acceptLanguage) ?? defaultLocale;
}

export function negotiateLocale(acceptLanguage: string | null | undefined): SupportedLocale | null {
	if (!acceptLanguage) return null;
	const candidates = acceptLanguage
		.split(',')
		.map((part) => {
			const [localePart, ...params] = part.trim().split(';');
			const qualityParam = params.find((param) => param.trim().startsWith('q='));
			const quality = qualityParam ? Number(qualityParam.trim().slice(2)) : 1;
			return {
				locale: normalizeLocale(localePart),
				quality: Number.isFinite(quality) ? quality : 1
			};
		})
		.filter((candidate): candidate is { locale: SupportedLocale; quality: number } =>
			Boolean(candidate.locale)
		)
		.sort((a, b) => b.quality - a.quality);

	return candidates[0]?.locale ?? null;
}

export function translate(
	locale: SupportedLocale | string | null | undefined,
	key: MessageKey,
	params: Record<string, string | number | null | undefined> = {}
) {
	const resolvedLocale = normalizeLocale(locale ?? '') ?? defaultLocale;
	const template = dictionaries[resolvedLocale]?.[key] ?? key;
	return interpolate(template, params);
}

export function interpolate(
	template: string,
	params: Record<string, string | number | null | undefined>
) {
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

export function createTranslator(locale: SupportedLocale | string | null | undefined) {
	return (key: MessageKey, params?: Record<string, string | number | null | undefined>) =>
		translate(locale, key, params);
}

export function formatCurrency(
	cents: number,
	locale: Intl.LocalesArgument = defaultLocale,
	currency = defaultCurrency
) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency
	}).format(cents / 100);
}

export function formatPercentage(
	value: number | null,
	locale: Intl.LocalesArgument = defaultLocale,
	t = createTranslator(
		Array.isArray(locale) ? locale[0] : typeof locale === 'string' ? locale : defaultLocale
	)
) {
	if (value == null) return t('No baseline');
	const sign = value >= 0 ? '+' : '';
	return `${sign}${new Intl.NumberFormat(locale, {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1
	}).format(value)}%`;
}

export function isValidCurrencyCode(value: string) {
	const currency = value.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return false;
	try {
		new Intl.NumberFormat(defaultLocale, { style: 'currency', currency }).format(1);
		return true;
	} catch {
		return false;
	}
}

export function defaultCurrencyForLocale(locale: SupportedLocale) {
	return locale === 'pt-BR' ? 'BRL' : defaultCurrency;
}

export const commonCurrencyCodes = [
	'USD',
	'BRL',
	'EUR',
	'GBP',
	'CAD',
	'AUD',
	'MXN',
	'ARS',
	'CLP',
	'COP',
	'JPY',
	'CHF'
] as const;
