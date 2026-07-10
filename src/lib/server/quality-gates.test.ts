import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string) {
	return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('quality gate configuration', () => {
	it('keeps every quality suite and Prometheus rules in the local aggregate', () => {
		const packageJson = JSON.parse(readProjectFile('package.json')) as {
			scripts: Record<string, string>;
		};

		expect(packageJson.scripts['test:quality']).toBe(
			'pnpm test:visual && pnpm test:performance && pnpm test:infrastructure && pnpm test:smoke && pnpm test:prometheus-rules'
		);
		expect(packageJson.scripts.verify).toContain('pnpm test:quality');
		expect(packageJson.scripts['test:prometheus-rules']).toBe(
			'scripts/ops/test-prometheus-rules.sh'
		);
	});

	it('runs browser quality suites and Prometheus validation as independent CI gates', () => {
		const workflow = readProjectFile('.github/workflows/ci.yml');

		expect(workflow).toContain('suite: [visual, performance, infrastructure, smoke]');
		expect(workflow).toContain('run: pnpm test:${{ matrix.suite }}');
		expect(workflow).toContain('prometheus-rules:');
		expect(workflow).toContain('run: scripts/ops/test-prometheus-rules.sh');
	});

	it('ships promtool in the required development container', () => {
		expect(readProjectFile('.devcontainer/Containerfile')).toMatch(/^\s*prometheus \\/m);
	});
});
