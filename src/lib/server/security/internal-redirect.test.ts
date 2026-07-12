import { describe, expect, it } from 'vitest';
import { getSafeInternalPath, safeInternalPath } from './internal-redirect';

describe('internal redirect validation', () => {
	it.each([
		['/app', '/app'],
		['/app/expenses?from=2026-07-01#summary', '/app/expenses?from=2026-07-01#summary'],
		['/app/../app/reports', '/app/reports']
	])('normalizes safe internal paths', (input, expected) => {
		expect(getSafeInternalPath(input)).toBe(expected);
	});

	it.each([
		null,
		'',
		'app',
		'https://evil.example',
		'//evil.example',
		'/\\evil.example',
		'/app\\evil.example',
		'/app\nSet-Cookie: injected=true'
	])('rejects unsafe redirect targets', (input) => {
		expect(getSafeInternalPath(input)).toBeNull();
		expect(safeInternalPath(input, '/app')).toBe('/app');
	});
});
