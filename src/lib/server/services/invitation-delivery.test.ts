import { describe, expect, it } from 'vitest';
import { classifyInvitationDeliveryError } from './invitation-delivery';

describe('invitation delivery error classification', () => {
	it.each([
		[new DOMException('request aborted', 'AbortError'), 'timeout'],
		[new Error('Email delivery is not configured.'), 'configuration'],
		[new Error('Mailjet API failed with HTTP 429'), 'provider_rejected'],
		[new Error('Mailjet API failed with HTTP 503'), 'provider_unavailable'],
		[new Error('fetch failed: ECONNRESET'), 'network'],
		[new Error('unexpected provider response'), 'unknown'],
		['not an error', 'unknown']
	] as const)('classifies %s as %s without persisting provider detail', (error, category) => {
		expect(classifyInvitationDeliveryError(error)).toBe(category);
	});
});
