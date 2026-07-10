import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { BlockList, isIP } from 'node:net';

type ProxyTrustConfig = {
	blockList: BlockList;
	raw: string;
};

let cachedProxyTrustConfig: ProxyTrustConfig | null | undefined;
let lastUntrustedPeerWarningConfig: string | null = null;
let lastInvalidForwardedWarningConfig: string | null = null;

function privateEnv(name: 'TRUST_PROXY_HEADERS' | 'TRUSTED_PROXY_CIDR' | 'NODE_ENV') {
	return env[name] ?? process.env[name];
}

function proxyHeadersEnabled() {
	return env.TRUST_PROXY_HEADERS === 'true' || process.env.TRUST_PROXY_HEADERS === 'true';
}

function normalizeAddress(address: string) {
	const withoutZone = address
		.trim()
		.replace(/^\[|\]$/g, '')
		.split('%', 1)[0];
	const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone)?.[1];
	return mappedIpv4 && isIP(mappedIpv4) === 4 ? mappedIpv4 : withoutZone;
}

function parseProxyTrustConfig(
	rawValue = privateEnv('TRUSTED_PROXY_CIDR')
): ProxyTrustConfig | null {
	const raw = rawValue?.trim() ?? '';
	if (!raw) return null;
	if (cachedProxyTrustConfig?.raw === raw) return cachedProxyTrustConfig;

	const blockList = new BlockList();
	const entries = raw
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	if (entries.length === 0) {
		throw new Error('TRUSTED_PROXY_CIDR must contain at least one CIDR.');
	}

	for (const entry of entries) {
		const [network, prefixText, ...extra] = entry.split('/');
		const family = isIP(network);
		const prefix = Number(prefixText);
		const maxPrefix = family === 4 ? 32 : 128;

		if (
			extra.length > 0 ||
			family === 0 ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > maxPrefix
		) {
			throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
		}

		blockList.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
	}

	cachedProxyTrustConfig = { blockList, raw };
	return cachedProxyTrustConfig;
}

function requestCameFromTrustedProxy(address: string) {
	let config: ProxyTrustConfig | null;
	try {
		config = parseProxyTrustConfig();
	} catch {
		return false;
	}
	if (!config) return false;

	const normalized = normalizeAddress(address);
	const family = isIP(normalized);
	return family !== 0 && config.blockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export function getClientIp(event: Pick<RequestEvent, 'request' | 'getClientAddress'>) {
	const directAddress = event.getClientAddress();
	if (proxyHeadersEnabled() && requestCameFromTrustedProxy(directAddress)) {
		const forwarded = event.request.headers.get('x-forwarded-for');
		const realIp = event.request.headers.get('x-real-ip');
		const candidate = forwarded?.split(',').at(-1)?.trim() || realIp?.trim();
		if (!candidate) return directAddress;

		const normalized = normalizeAddress(candidate);
		if (isIP(normalized) !== 0) return normalized;
		warnInvalidForwardedAddress();
		return directAddress;
	}
	if (proxyHeadersEnabled()) warnUntrustedProxyPeer();

	return directAddress;
}

function warnUntrustedProxyPeer() {
	const raw = privateEnv('TRUSTED_PROXY_CIDR')?.trim() || '<missing>';
	if (lastUntrustedPeerWarningConfig === raw) return;
	lastUntrustedPeerWarningConfig = raw;
	console.warn(
		JSON.stringify({
			level: 'warn',
			message: 'proxy_trust: immediate peer did not match TRUSTED_PROXY_CIDR'
		})
	);
}

function warnInvalidForwardedAddress() {
	const raw = privateEnv('TRUSTED_PROXY_CIDR')?.trim() || '<missing>';
	if (lastInvalidForwardedWarningConfig === raw) return;
	lastInvalidForwardedWarningConfig = raw;
	console.warn(
		JSON.stringify({
			level: 'warn',
			message: 'proxy_trust: trusted proxy supplied an invalid client address'
		})
	);
}

/**
 * Validate trusted-proxy configuration once at server startup. Production
 * refuses to start when proxy headers are enabled without a valid proxy CIDR;
 * non-production environments warn and safely ignore forwarded headers.
 *
 * Call this once at server startup (outside of any request handler).
 */
export function assertProxyTrustConfig() {
	if (!proxyHeadersEnabled()) return;

	let message: string | null = null;
	try {
		if (!parseProxyTrustConfig()) {
			message =
				'[security] TRUST_PROXY_HEADERS is enabled but TRUSTED_PROXY_CIDR is not set. ' +
				'Configure the immediate reverse proxy subnet before trusting forwarded client addresses.';
		}
	} catch (error) {
		message = `[security] ${error instanceof Error ? error.message : 'TRUSTED_PROXY_CIDR is invalid.'}`;
	}

	if (!message) return;
	if (privateEnv('NODE_ENV') === 'production') throw new Error(message);
	console.warn(message);
}
