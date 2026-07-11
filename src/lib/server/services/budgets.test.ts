import { describe, expect, it } from 'vitest';
import { classifyBudgetAlertDeliveryError } from './budgets';

describe('budget alert delivery error classification', () => {
	it.each([
		[new Error('request timed out'), 'timeout'],
		[new Error('Email delivery is not configured.'), 'configuration'],
		[new Error('Mailjet API failed with HTTP 429: private response'), 'provider_rejected'],
		[new Error('Mailjet API failed with HTTP 503: private response'), 'provider_unavailable'],
		[new Error('fetch failed: ECONNRESET'), 'network'],
		[new Error('unexpected provider failure'), 'unknown'],
		['not an error', 'unknown']
	] as const)('maps provider failures to a coarse category', (failure, expected) => {
		expect(classifyBudgetAlertDeliveryError(failure)).toBe(expected);
	});
});
