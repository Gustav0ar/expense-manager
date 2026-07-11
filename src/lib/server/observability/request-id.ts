import { randomUUID } from 'node:crypto';

const externalRequestIdPattern = /^[A-Za-z0-9-]{1,64}$/;

export interface RequestIdentity {
	requestId: string;
	externalRequestId?: string;
}

export function parseExternalRequestId(value: string | null | undefined) {
	if (!value || !externalRequestIdPattern.test(value)) return undefined;
	return value;
}

export function createRequestIdentity(
	externalValue: string | null | undefined,
	generateRequestId: () => string = randomUUID
): RequestIdentity {
	const externalRequestId = parseExternalRequestId(externalValue);
	return {
		requestId: generateRequestId(),
		...(externalRequestId ? { externalRequestId } : {})
	};
}
