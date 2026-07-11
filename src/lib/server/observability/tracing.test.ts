import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('$app/environment', () => ({
	browser: false,
	building: false,
	dev: false,
	version: 'test'
}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	normalizeOtelTracesEndpoint,
	parseTraceSampleRate,
	shutdownTracing,
	startTracing,
	traceRequest
} from './tracing';

describe('tracing configuration', () => {
	afterEach(async () => {
		await shutdownTracing().catch(() => undefined);
		for (const key of Object.keys(privateEnv)) delete privateEnv[key];
		vi.restoreAllMocks();
	});

	it('normalizes generic OTLP HTTP endpoints to the traces endpoint', () => {
		expect(normalizeOtelTracesEndpoint('http://tempo:4318')).toBe('http://tempo:4318/v1/traces');
		expect(normalizeOtelTracesEndpoint('http://tempo:4318/')).toBe('http://tempo:4318/v1/traces');
		expect(normalizeOtelTracesEndpoint('http://tempo:4318/v1/traces')).toBe(
			'http://tempo:4318/v1/traces'
		);
	});

	it('prefers an explicit traces endpoint over the generic endpoint', () => {
		expect(
			normalizeOtelTracesEndpoint('http://collector:4318', 'http://collector:4318/custom/traces')
		).toBe('http://collector:4318/custom/traces');
	});

	it('keeps sample rates within the OpenTelemetry range', () => {
		expect(parseTraceSampleRate(undefined)).toBe(0.1);
		expect(parseTraceSampleRate('bad')).toBe(0.1);
		expect(parseTraceSampleRate('-1')).toBe(0);
		expect(parseTraceSampleRate('0.25')).toBe(0.25);
		expect(parseTraceSampleRate('2')).toBe(1);
	});

	it('does not start tracing unless explicitly enabled', () => {
		privateEnv.OTEL_TRACING_ENABLED = 'false';

		expect(startTracing()).toBe(false);
	});

	it('does not start tracing without an OTLP endpoint', () => {
		privateEnv.OTEL_TRACING_ENABLED = 'true';
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(startTracing()).toBe(false);
	});

	it('passes requests through unchanged when tracing is disabled', async () => {
		privateEnv.OTEL_TRACING_ENABLED = 'false';

		const response = await traceRequest(createRequestEvent(), async () => new Response('ok'));

		expect(await response.text()).toBe('ok');
	});

	it('handles SDK startup failures and shuts down a successfully started SDK', async () => {
		privateEnv.OTEL_TRACING_ENABLED = 'true';
		privateEnv.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const start = vi.spyOn(NodeSDK.prototype, 'start').mockImplementationOnce(() => {
			throw new Error('startup failed');
		});
		expect(startTracing()).toBe(false);
		start.mockImplementation(() => undefined);

		const shutdown = vi.spyOn(NodeSDK.prototype, 'shutdown').mockResolvedValue(undefined as never);
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		expect(startTracing()).toBe(true);
		expect(startTracing()).toBe(true);
		await shutdownTracing();
		expect(shutdown).toHaveBeenCalledOnce();
		await expect(shutdownTracing()).resolves.toBeUndefined();
	});

	it('records successful, server-error and thrown request outcomes without changing responses', async () => {
		privateEnv.OTEL_TRACING_ENABLED = 'true';
		privateEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/custom';
		privateEnv.OTEL_TRACES_SAMPLE_RATE = '0.5';
		privateEnv.OTEL_SERVICE_NAME = 'coverage-service';
		privateEnv.OTEL_DEPLOYMENT_ENVIRONMENT = 'test';
		vi.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);
		vi.spyOn(NodeSDK.prototype, 'shutdown').mockResolvedValue(undefined as never);
		vi.spyOn(console, 'info').mockImplementation(() => undefined);

		const fakeSpan = {
			setAttribute: vi.fn(),
			setStatus: vi.fn(),
			recordException: vi.fn(),
			spanContext: () => ({ traceId: '0123456789abcdef0123456789abcdef' }),
			end: vi.fn()
		};
		vi.spyOn(trace, 'getTracer').mockReturnValue({
			startActiveSpan: (
				_name: string,
				_options: unknown,
				callback: (span: typeof fakeSpan) => unknown
			) => callback(fakeSpan)
		} as never);

		try {
			const ok = await traceRequest(createRequestEvent(), async () => new Response('ok'));
			expect(ok.headers.get('X-Trace-Id')).toBe('0123456789abcdef0123456789abcdef');
			const unavailable = await traceRequest(
				createRequestEvent({ routeId: null, authenticated: true }),
				async () => new Response('down', { status: 503 })
			);
			expect(unavailable.status).toBe(503);
			expect(fakeSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: 'HTTP 503'
			});

			await expect(
				traceRequest(createRequestEvent(), async () => {
					throw Object.assign(new Error('failed'), { status: 500 });
				})
			).rejects.toThrow('failed');
			expect(fakeSpan.recordException).toHaveBeenCalled();
			await expect(
				traceRequest(createRequestEvent(), async () => {
					throw { status: 400 };
				})
			).rejects.toMatchObject({ status: 400 });
			expect(fakeSpan.end).toHaveBeenCalledTimes(4);
		} finally {
			await shutdownTracing();
		}
	});

	it('does not fail requests when a response has immutable headers', async () => {
		privateEnv.OTEL_TRACING_ENABLED = 'true';
		privateEnv.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
		vi.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);
		vi.spyOn(NodeSDK.prototype, 'shutdown').mockResolvedValue(undefined as never);
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const fakeSpan = {
			setAttribute: vi.fn(),
			setStatus: vi.fn(),
			recordException: vi.fn(),
			spanContext: () => ({ traceId: 'trace-id' }),
			end: vi.fn()
		};
		vi.spyOn(trace, 'getTracer').mockReturnValue({
			startActiveSpan: (
				_name: string,
				_options: unknown,
				callback: (span: typeof fakeSpan) => unknown
			) => callback(fakeSpan)
		} as never);
		const immutable = {
			status: 204,
			headers: {
				set: () => {
					throw new TypeError('immutable');
				}
			}
		} as unknown as Response;
		try {
			await expect(traceRequest(createRequestEvent(), async () => immutable)).resolves.toBe(
				immutable
			);
		} finally {
			await shutdownTracing();
		}
	});
});

function createRequestEvent(input: { routeId?: string | null; authenticated?: boolean } = {}) {
	return {
		request: new Request('http://localhost/app/dashboard'),
		url: new URL('http://localhost/app/dashboard'),
		route: { id: input.routeId === undefined ? '/app/dashboard' : input.routeId },
		locals: input.authenticated ? { user: { id: 'user-1' }, requestId: 'request-1' } : {}
	} as unknown as RequestEvent;
}
