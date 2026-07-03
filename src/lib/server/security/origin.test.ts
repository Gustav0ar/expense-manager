import { describe, expect, it } from 'vitest';
import { buildTrustedOrigins, isTrustedOrigin, parseTrustedOrigins } from './origin';

describe('origin security helpers', () => {
	it('normalizes configured trusted origins', () => {
		expect(
			parseTrustedOrigins(' http://100.64.0.1:5173/app , https://financeiro.example.com ,invalid')
		).toEqual(['http://100.64.0.1:5173', 'https://financeiro.example.com']);
	});

	it('deduplicates base and extra trusted origins', () => {
		expect(
			buildTrustedOrigins({
				baseURL: 'http://localhost:5173',
				trustedOrigins: 'http://localhost:5173, http://100.64.0.1:5173'
			})
		).toEqual(['http://localhost:5173', 'http://100.64.0.1:5173']);
	});

	it('allows same-origin development requests such as Tailscale URLs', () => {
		expect(
			isTrustedOrigin({
				origin: 'http://100.64.0.1:5173',
				baseURL: 'http://localhost:5173',
				requestOrigin: 'http://100.64.0.1:5173',
				dev: true
			})
		).toBe(true);
	});

	it('requires explicit trust for alternate production origins', () => {
		expect(
			isTrustedOrigin({
				origin: 'http://100.64.0.1:5173',
				baseURL: 'https://financeiro.example.com',
				requestOrigin: 'http://100.64.0.1:5173',
				dev: false
			})
		).toBe(false);
		expect(
			isTrustedOrigin({
				origin: 'http://100.64.0.1:5173',
				baseURL: 'https://financeiro.example.com',
				trustedOrigins: 'http://100.64.0.1:5173',
				requestOrigin: 'http://100.64.0.1:5173',
				dev: false
			})
		).toBe(true);
	});

	it('rejects malformed and unrelated origins', () => {
		expect(isTrustedOrigin({ origin: 'not-a-url', baseURL: 'http://localhost:5173' })).toBe(false);
		expect(
			isTrustedOrigin({
				origin: 'https://evil.example',
				baseURL: 'http://localhost:5173',
				requestOrigin: 'http://localhost:5173',
				dev: true
			})
		).toBe(false);
	});

	it('handles an invalid baseURL gracefully — builds trusted set from extra origins only', () => {
		// When baseURL cannot be parsed, normalizeOrigin returns null and the
		// if (baseOrigin) branch on origin.ts:18 is false — this covers that path.
		expect(
			buildTrustedOrigins({
				baseURL: 'not-a-url',
				trustedOrigins: 'http://100.64.0.1:5173'
			})
		).toEqual(['http://100.64.0.1:5173']);
	});
});
