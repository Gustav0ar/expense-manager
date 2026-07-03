import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	normalizeOtelTracesEndpoint,
	parseTraceSampleRate,
	startTracing,
	traceRequest
} from './tracing';

describe('tracing configuration', () => {
	afterEach(() => {
		delete process.env.OTEL_TRACING_ENABLED;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
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
		process.env.OTEL_TRACING_ENABLED = 'false';

		expect(startTracing()).toBe(false);
	});

	it('does not start tracing without an OTLP endpoint', () => {
		process.env.OTEL_TRACING_ENABLED = 'true';
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(startTracing()).toBe(false);
	});

	it('passes requests through unchanged when tracing is disabled', async () => {
		process.env.OTEL_TRACING_ENABLED = 'false';

		const response = await traceRequest(createRequestEvent(), async () => new Response('ok'));

		expect(await response.text()).toBe('ok');
	});
});

function createRequestEvent() {
	return {
		request: new Request('http://localhost/app/dashboard'),
		url: new URL('http://localhost/app/dashboard'),
		route: { id: '/app/dashboard' },
		locals: {}
	} as unknown as RequestEvent;
}
