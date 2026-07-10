import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { getClientIp, assertProxyTrustConfig } from './client-ip';

function makeEvent(headers: Record<string, string> = {}): Parameters<typeof getClientIp>[0] {
	return {
		request: new Request('http://localhost/', { headers }),
		getClientAddress: () => '10.0.0.1'
	};
}

describe('getClientIp', () => {
	beforeEach(() => {
		Object.keys(privateEnv).forEach((k) => delete privateEnv[k]);
		delete process.env.TRUST_PROXY_HEADERS;
		delete process.env.TRUSTED_PROXY_CIDR;
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns getClientAddress() when proxy trust is disabled', () => {
		expect(getClientIp(makeEvent({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.1');
	});

	it('returns last hop of X-Forwarded-For when proxy trust is enabled', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '10.0.0.0/8';
		expect(getClientIp(makeEvent({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8');
	});

	it('returns X-Real-IP when X-Forwarded-For is absent and proxy trust is enabled', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '10.0.0.0/8';
		expect(getClientIp(makeEvent({ 'x-real-ip': '9.10.11.12' }))).toBe('9.10.11.12');
	});

	it('falls back to getClientAddress() when trusted header is empty', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '10.0.0.0/8';
		expect(getClientIp(makeEvent({ 'x-forwarded-for': '' }))).toBe('10.0.0.1');
	});

	it('rejects malformed forwarded client addresses from a trusted proxy', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '10.0.0.0/8';
		expect(getClientIp(makeEvent({ 'x-forwarded-for': 'not-an-ip' }))).toBe('10.0.0.1');
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it('respects TRUST_PROXY_HEADERS from process.env as a fallback', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';
		process.env.TRUSTED_PROXY_CIDR = '10.0.0.0/8';
		expect(getClientIp(makeEvent({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
	});

	it('ignores forwarded headers when the immediate peer is outside the trusted CIDR', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '172.16.0.0/12';
		expect(getClientIp(makeEvent({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.1');
		expect(getClientIp(makeEvent({ 'x-forwarded-for': '5.6.7.8' }))).toBe('10.0.0.1');
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it('accepts IPv4-mapped proxy addresses and comma-separated CIDRs', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '10.0.0.0/8,172.16.0.0/12';
		const event = makeEvent({ 'x-real-ip': '9.9.9.9' });
		event.getClientAddress = () => '::ffff:172.20.0.4';
		expect(getClientIp(event)).toBe('9.9.9.9');
	});
});

describe('assertProxyTrustConfig', () => {
	beforeEach(() => {
		Object.keys(privateEnv).forEach((k) => delete privateEnv[k]);
		delete process.env.TRUST_PROXY_HEADERS;
		delete process.env.TRUSTED_PROXY_CIDR;
		delete process.env.NODE_ENV;
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not warn when proxy trust is disabled', () => {
		assertProxyTrustConfig();
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('does not warn when TRUST_PROXY_HEADERS is enabled and TRUSTED_PROXY_CIDR is set', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '172.16.0.0/12';
		assertProxyTrustConfig();
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('warns outside production when TRUST_PROXY_HEADERS is enabled without a proxy CIDR', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.NODE_ENV = 'development';
		assertProxyTrustConfig();
		expect(console.warn).toHaveBeenCalledOnce();
		expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('TRUST_PROXY_HEADERS');
		expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('TRUSTED_PROXY_CIDR');
	});

	it('warns when enabled via process.env without a proxy CIDR', () => {
		process.env.TRUST_PROXY_HEADERS = 'true';
		process.env.NODE_ENV = 'development';
		assertProxyTrustConfig();
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it('throws in production when proxy trust is incomplete', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.NODE_ENV = 'production';
		expect(() => assertProxyTrustConfig()).toThrow('TRUSTED_PROXY_CIDR');
	});

	it('throws in production when a proxy CIDR is invalid', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = '172.16.0.0/99';
		privateEnv.NODE_ENV = 'production';
		expect(() => assertProxyTrustConfig()).toThrow('Invalid trusted proxy CIDR');
	});

	it('throws in production when the CIDR list contains no entries', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';
		privateEnv.TRUSTED_PROXY_CIDR = ' , , ';
		privateEnv.NODE_ENV = 'production';
		expect(() => assertProxyTrustConfig()).toThrow('at least one CIDR');
	});
});
