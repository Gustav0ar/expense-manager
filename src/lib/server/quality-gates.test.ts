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
			'pnpm test:visual && pnpm test:performance && pnpm test:query-plans && pnpm test:infrastructure && pnpm test:smoke && pnpm test:prometheus-rules'
		);
		expect(packageJson.scripts.verify).toContain('pnpm test:quality');
		expect(packageJson.scripts.verify).toContain('pnpm test:attachment-recovery');
		expect(packageJson.scripts['test:prometheus-rules']).toBe(
			'scripts/ops/test-prometheus-rules.sh'
		);
	});

	it('pins PostgreSQL 18 and runs attachment recovery in the main CI gate', () => {
		const workflow = readProjectFile('.github/workflows/ci.yml');

		expect(workflow).toContain('name: Install PostgreSQL 18 client');
		expect(workflow).toContain('signed-by=/usr/share/keyrings/postgresql-pgdg.gpg');
		expect(workflow).toContain('postgresql-client-18');
		expect(workflow).toContain('postgres_bin=/usr/lib/postgresql/18/bin');
		expect(workflow).toContain('test -x "${postgres_bin}/pg_dump"');
		expect(workflow).toContain('echo "${postgres_bin}" >> "$GITHUB_PATH"');
		expect(workflow).toContain("grep -E '^pg_dump \\(PostgreSQL\\) 18\\.'");
		expect(workflow).toMatch(
			/pnpm test:migrations[\s\S]*name: Verify attachment backup and recovery[\s\S]*run: pnpm test:attachment-recovery/
		);
	});

	it('runs quality suites and Prometheus validation as independent CI gates', () => {
		const workflow = readProjectFile('.github/workflows/ci.yml');

		expect(workflow).toContain('suite: [visual, performance, query-plans, infrastructure, smoke]');
		expect(workflow).toContain('run: pnpm test:${{ matrix.suite }}');
		expect(workflow).toContain('prometheus-rules:');
		expect(workflow).toContain('run: scripts/ops/test-prometheus-rules.sh');
	});

	it('ships promtool in the required development container', () => {
		expect(readProjectFile('.devcontainer/Containerfile')).toMatch(/^\s*prometheus \\/m);
	});
});
