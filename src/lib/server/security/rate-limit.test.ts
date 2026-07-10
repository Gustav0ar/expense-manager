import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { getClientIp } from './client-ip';

function requestWithHeaders(headers: Record<string, string>) {
	return {
		request: new Request('http://localhost/login', { headers }),
		getClientAddress: () => '198.51.100.10'
	};
}

describe('rate limit client IP resolution', () => {
	beforeEach(() => {
		Object.keys(privateEnv).forEach((key) => delete privateEnv[key]);
		privateEnv.TRUSTED_PROXY_CIDR = '198.51.100.0/24';
	});

	afterEach(() => {
		Object.keys(privateEnv).forEach((key) => delete privateEnv[key]);
	});

	it('ignores forwarded headers unless proxy headers are trusted', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';

		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10' }))).toBe(
			'198.51.100.10'
		);
	});

	it('uses the rightmost (proxy-appended) forwarded IP when proxy headers are trusted', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';

		// The rightmost value is appended by the trusted proxy and cannot be
		// forged by the client, unlike the leftmost value.
		expect(
			getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10, 198.51.100.20' }))
		).toBe('198.51.100.20');
	});

	it('falls back to x-real-ip when there is no forwarded chain', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';

		expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.20' }))).toBe('203.0.113.20');
	});

	describe('X-Forwarded-For security: rightmost-IP prevents rate-limit bypass', () => {
		it('returns the last IP in a multi-hop chain (proxy-appended, unforgeable)', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			// Client sends fake IP as first hop; real proxy appends real IP at the end.
			// We must use the rightmost value so the attacker cannot bypass rate limits
			// by rotating the leading IP.
			const result = getClientIp(
				requestWithHeaders({ 'x-forwarded-for': '192.0.2.30, 192.0.2.40, 198.51.100.20' })
			);
			expect(result).toBe('198.51.100.20');
		});

		it('trims whitespace from the extracted IP', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(
				getClientIp(requestWithHeaders({ 'x-forwarded-for': '192.0.2.30,  198.51.100.20  ' }))
			).toBe('198.51.100.20');
		});

		it('falls back to getClientAddress when forwarded header is empty', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when forwarded header is whitespace-only', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '   ' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when x-real-ip is empty', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when x-real-ip is whitespace-only', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '  ' }))).toBe('198.51.100.10');
		});
	});
});
