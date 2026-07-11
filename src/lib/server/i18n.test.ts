import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	getLocalePreference,
	internalErrorMessage,
	resolveRequestLocale,
	setLocalePreference
} from './i18n';

describe('server error localization', () => {
	it('localizes generic internal errors without exposing implementation details', () => {
		expect(internalErrorMessage('en')).toBe('Internal error.');
		expect(internalErrorMessage('pt-BR')).toBe('Erro interno.');
		expect(internalErrorMessage(undefined)).toBe('Internal error.');
	});

	it('reads, writes and clears locale preferences with secure cookie defaults', () => {
		const cookies = cookieJar({ locale: 'pt-BR' });
		expect(getLocalePreference(cookies)).toBe('pt-BR');
		setLocalePreference(cookies, 'en');
		expect(cookies.set).toHaveBeenCalledWith(
			'locale',
			'en',
			expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax' })
		);
		setLocalePreference(cookies, 'system');
		expect(cookies.delete).toHaveBeenCalledWith('locale', { path: '/' });
		expect(getLocalePreference(cookieJar({ locale: 'invalid' }))).toBe('system');
	});

	it('resolves system and explicit request locales', () => {
		const systemEvent = {
			cookies: cookieJar(),
			request: new Request('http://localhost', {
				headers: { 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' }
			})
		} as unknown as RequestEvent;
		expect(resolveRequestLocale(systemEvent)).toEqual({ preference: 'system', locale: 'pt-BR' });
		const explicitEvent = {
			cookies: cookieJar({ locale: 'en' }),
			request: new Request('http://localhost', { headers: { 'accept-language': 'pt-BR' } })
		} as unknown as RequestEvent;
		expect(resolveRequestLocale(explicitEvent)).toEqual({ preference: 'en', locale: 'en' });
	});
});

function cookieJar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		get: vi.fn((name: string) => values.get(name)),
		set: vi.fn((name: string, value: string) => values.set(name, value)),
		delete: vi.fn((name: string) => values.delete(name))
	} as unknown as Cookies & {
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
}
