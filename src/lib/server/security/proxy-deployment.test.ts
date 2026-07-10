import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string) {
	return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('trusted proxy deployment contract', () => {
	it('does not ship a broad trusted-network default in production Compose files', () => {
		for (const composeFile of ['docker-compose.yml', 'docker-compose.traefik.yml']) {
			const compose = readProjectFile(composeFile);
			expect(compose, composeFile).toContain('TRUSTED_PROXY_CIDR: ${TRUSTED_PROXY_CIDR:-}');
			expect(compose, composeFile).not.toMatch(
				/TRUSTED_PROXY_CIDR:.*(?:172\.16\.0\.0\/12|10\.0\.0\.0\/8)/
			);
		}
	});

	it('propagates and validates the CIDR in the GitHub deployment workflow', () => {
		const workflow = readProjectFile('.github/workflows/deploy.yml');
		expect(workflow).toContain("TRUSTED_PROXY_CIDR: ${{ vars.TRUSTED_PROXY_CIDR || '' }}");
		expect(workflow).toContain('write_env_var TRUSTED_PROXY_CIDR "${TRUSTED_PROXY_CIDR}"');
		expect(workflow).toContain('required_keys+=(TRUSTED_PROXY_CIDR)');
	});
});
