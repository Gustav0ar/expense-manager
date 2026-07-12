const INTERNAL_REDIRECT_ORIGIN = 'http://expense-manager.internal';

/**
 * Returns a normalized same-origin path, or null when the input is not a safe
 * internal redirect target. Do not use a request-controlled origin as the base.
 */
export function getSafeInternalPath(value: string | null | undefined) {
	if (!value || !value.startsWith('/') || value.includes('\\') || hasControlCharacter(value)) {
		return null;
	}

	try {
		const url = new URL(value, INTERNAL_REDIRECT_ORIGIN);
		if (url.origin !== INTERNAL_REDIRECT_ORIGIN) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}

export function safeInternalPath(value: string | null | undefined, fallback: string) {
	return getSafeInternalPath(value) ?? fallback;
}

function hasControlCharacter(value: string) {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}
