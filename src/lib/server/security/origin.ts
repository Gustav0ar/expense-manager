export function parseTrustedOrigins(value?: string | null) {
	if (!value) return [];

	return value
		.split(',')
		.map((origin) => normalizeOrigin(origin))
		.filter((origin): origin is string => Boolean(origin));
}

export function buildTrustedOrigins(input: {
	baseURL?: string | null;
	trustedOrigins?: string | null;
	requestOrigin?: string | null;
	dev?: boolean;
}) {
	const origins = new Set<string>();
	const baseOrigin = normalizeOrigin(input.baseURL);
	if (baseOrigin) origins.add(baseOrigin);

	for (const origin of parseTrustedOrigins(input.trustedOrigins)) {
		origins.add(origin);
	}

	const requestOrigin = normalizeOrigin(input.requestOrigin);
	if (input.dev && requestOrigin) origins.add(requestOrigin);

	return [...origins];
}

export function isTrustedOrigin(input: {
	origin?: string | null;
	baseURL?: string | null;
	trustedOrigins?: string | null;
	requestOrigin?: string | null;
	dev?: boolean;
}) {
	const origin = normalizeOrigin(input.origin);
	if (!origin) return Boolean(input.dev);

	return buildTrustedOrigins(input).includes(origin);
}

function normalizeOrigin(value?: string | null) {
	if (!value) return null;

	try {
		const url = new URL(value.trim());
		return url.origin;
	} catch {
		return null;
	}
}
