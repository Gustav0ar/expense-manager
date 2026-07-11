import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	traceRequest: vi.fn(),
	getSession: vi.fn(),
	svelteKitHandler: vi.fn()
}));

vi.mock('$app/environment', () => ({ building: true, dev: false }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('better-auth/svelte-kit', () => ({ svelteKitHandler: mocks.svelteKitHandler }));
vi.mock('$lib/server/theme', () => ({ getThemePreference: () => 'system' }));
vi.mock('$lib/server/i18n', () => ({
	internalErrorMessage: () => 'Internal error.',
	resolveRequestLocale: () => ({ locale: 'en', preference: 'auto' })
}));
vi.mock('$lib/i18n', () => ({ translate: (_locale: string, key: string) => key }));
vi.mock('$lib/server/services/mfa', () => ({
	isMfaEnabled: vi.fn(),
	isMfaSessionVerified: vi.fn()
}));
vi.mock('$lib/server/security/origin', () => ({ isTrustedOrigin: () => true }));
vi.mock('$lib/server/security/client-ip', () => ({ assertProxyTrustConfig: vi.fn() }));
vi.mock('$lib/server/registration', () => ({ isRegistrationEnabled: () => true }));
vi.mock('$lib/server/observability/tracing', () => ({ traceRequest: mocks.traceRequest }));
vi.mock('$lib/server/background-jobs', () => ({
	startBackgroundJobs: vi.fn(),
	triggerBackgroundJobs: vi.fn()
}));
vi.mock('$lib/server/shutdown', () => ({ registerGracefulShutdown: vi.fn() }));

import { handle, handleError } from './hooks.server';

describe('request ID hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue(null);
		mocks.svelteKitHandler.mockResolvedValue(new Response('ok'));
		mocks.traceRequest.mockImplementation(
			async (_event: RequestEvent, handleRequest: () => Promise<Response>) => handleRequest()
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses one internal ID across tracing, the response and error logs', async () => {
		const event = createRequestEvent('01ARZ3NDEKTSV4RRFFQ69G5FAV');
		let tracedRequestId: string | undefined;
		let tracedExternalRequestId: string | undefined;
		mocks.traceRequest.mockImplementationOnce(
			async (tracedEvent: RequestEvent, handleRequest: () => Promise<Response>) => {
				tracedRequestId = tracedEvent.locals.requestId;
				tracedExternalRequestId = tracedEvent.locals.externalRequestId;
				return handleRequest();
			}
		);

		const response = await handle({ event, resolve: vi.fn() } as never);
		const responseRequestId = response.headers.get('X-Request-Id');
		expect(responseRequestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(tracedRequestId).toBe(responseRequestId);
		expect(tracedExternalRequestId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');

		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const errorBody = (await handleError({
			error: new Error('failed'),
			event,
			status: 500,
			message: 'Internal Error'
		} as never)) as App.Error;
		const entry = JSON.parse(String(log.mock.calls[0][0]));
		expect(errorBody.requestId).toBe(responseRequestId);
		expect(entry.requestId).toBe(responseRequestId);
		expect(entry.externalRequestId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
	});

	it('never exposes or logs an invalid external ID', async () => {
		const invalidExternalId = 'invalid/request';
		const event = createRequestEvent(invalidExternalId);
		const response = await handle({ event, resolve: vi.fn() } as never);
		expect(response.headers.get('X-Request-Id')).not.toBe(invalidExternalId);
		expect(event.locals.externalRequestId).toBeUndefined();

		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		handleError({
			error: new Error('failed'),
			event,
			status: 500,
			message: 'Internal Error'
		} as never);
		expect(String(log.mock.calls[0][0])).not.toContain(invalidExternalId);
	});

	it('mints one stable internal ID when error handling starts before the request hook', async () => {
		const event = createRequestEvent('invalid/request');
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const reportError = async () =>
			(await handleError({
				error: new Error('failed'),
				event,
				status: 500,
				message: 'Internal Error'
			} as never)) as App.Error;

		const first = await reportError();
		const second = await reportError();
		expect(first.requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(second.requestId).toBe(first.requestId);
		expect(event.locals.requestId).toBe(first.requestId);
		expect(event.locals.externalRequestId).toBeUndefined();
		expect(log.mock.calls.map(([entry]) => String(entry)).join('')).not.toContain(
			'invalid/request'
		);
	});
});

function createRequestEvent(externalRequestId: string) {
	const url = new URL('http://localhost/app/dashboard');
	return {
		request: new Request(url, { headers: { 'X-Request-Id': externalRequestId } }),
		url,
		route: { id: '/app/dashboard' },
		locals: {},
		cookies: {}
	} as unknown as RequestEvent;
}
