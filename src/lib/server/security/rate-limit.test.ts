import { afterEach, describe, expect, it } from 'vitest';
import { getClientIp } from './client-ip';

function requestWithHeaders(headers: Record<string, string>) {
	return {
		request: new Request('http://localhost/login', { headers }),
		getClientAddress: () => '198.51.100.10'
	};
}

describe('rate limit client IP resolution', () => {
	afterEach(() => {
		delete process.env.TRUST_PROXY_HEADERS;
	});

	it('ignores forwarded headers unless proxy headers are trusted', () => {
		process.env.TRUST_PROXY_HEADERS = 'false';

		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10' }))).toBe(
			'198.51.100.10'
		);
	});

	it('uses the first forwarded IP only when proxy headers are trusted', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';

		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10, 198.51.100.20' }))).toBe(
			'203.0.113.10'
		);
	});

	it('falls back to x-real-ip when there is no forwarded chain', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';

		expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.20' }))).toBe('203.0.113.20');
	});
});
