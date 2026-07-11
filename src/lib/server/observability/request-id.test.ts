import { describe, expect, it, vi } from 'vitest';
import { createRequestIdentity, parseExternalRequestId } from './request-id';

describe('external request IDs', () => {
	it.each([
		['UUID', '550e8400-e29b-41d4-a716-446655440000'],
		['ULID', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
		['mixed ASCII identifier', 'edge-Proxy-123'],
		['maximum length', 'A'.repeat(64)]
	])('accepts a bounded %s', (_label, value) => {
		expect(parseExternalRequestId(value)).toBe(value);
	});

	it.each([
		['missing', undefined],
		['empty', ''],
		['oversized', 'A'.repeat(65)],
		['control characters', 'proxy\r\nX-Injected-Header'],
		['Unicode', 'requisição'],
		['punctuation outside the contract', 'proxy/request']
	])('rejects %s input', (_label, value) => {
		expect(parseExternalRequestId(value)).toBeUndefined();
	});

	it('always creates a separate internal request ID exactly once', () => {
		const generateRequestId = vi.fn(() => 'internal-request-id');

		expect(createRequestIdentity('external-request-id', generateRequestId)).toEqual({
			requestId: 'internal-request-id',
			externalRequestId: 'external-request-id'
		});
		expect(generateRequestId).toHaveBeenCalledOnce();
	});

	it.each([
		['missing', undefined],
		['invalid', 'invalid/value']
	])('creates an internal ID without retaining %s external input', (_label, value) => {
		expect(createRequestIdentity(value, () => 'internal-request-id')).toEqual({
			requestId: 'internal-request-id'
		});
	});
});
