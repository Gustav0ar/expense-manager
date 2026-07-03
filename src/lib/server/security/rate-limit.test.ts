import { afterEach, describe, expect, it } from 'vitest';
import { getClientIp } from './client-ip';

function requestWithHeaders(headers: Record<string, string>) {
	return {
		request: new Request('http://localhost/login', { headers }),
		getClientAddress: () => '10.0.0.10'
	};
}

describe('rate limit client IP resolution', () => {
	afterEach(() => {
		delete process.env.TRUST_PROXY_HEADERS;
	});

	it('ignores forwarded headers unless proxy headers are trusted', () => {
		process.env.TRUST_PROXY_HEADERS = 'false';

		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10' }))).toBe(
			'10.0.0.10'
		);
	});

	it('uses the rightmost (proxy-appended) forwarded IP when proxy headers are trusted', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';

		// The rightmost value is appended by the trusted proxy and cannot be
		// forged by the client, unlike the leftmost value.
		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.20' }))).toBe(
			'10.0.0.20'
		);
	});

	it('falls back to x-real-ip when there is no forwarded chain', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';

		expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.20' }))).toBe('203.0.113.20');
	});

	describe('X-Forwarded-For security: rightmost-IP prevents rate-limit bypass', () => {
		it('returns the last IP in a multi-hop chain (proxy-appended, unforgeable)', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			// Client sends fake IP as first hop; real proxy appends real IP at the end.
			// We must use the rightmost value so the attacker cannot bypass rate limits
			// by rotating the leading IP.
			const result = getClientIp(
				requestWithHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 10.0.0.20' })
			);
			expect(result).toBe('10.0.0.20');
		});

		it('trims whitespace from the extracted IP', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '1.2.3.4,  10.0.0.20  ' }))).toBe(
				'10.0.0.20'
			);
		});

		it('falls back to getClientAddress when forwarded header is empty', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '' }))).toBe('10.0.0.10');
		});

		it('falls back to getClientAddress when forwarded header is whitespace-only', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '   ' }))).toBe('10.0.0.10');
		});

		it('falls back to getClientAddress when x-real-ip is empty', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '' }))).toBe('10.0.0.10');
		});

		it('falls back to getClientAddress when x-real-ip is whitespace-only', () => {
			process.env.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '  ' }))).toBe('10.0.0.10');
		});
	});
});
