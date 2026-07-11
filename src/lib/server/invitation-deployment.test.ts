import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function projectFile(path: string) {
	return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('invitation key rotation deployment', () => {
	it.each(['docker-compose.yml', 'docker-compose.traefik.yml'])(
		'mounts an optional previous-secret file in %s',
		(composeFile) => {
			const compose = projectFile(composeFile);
			expect(compose).toContain(
				'BETTER_AUTH_SECRET_PREVIOUS_FILE: /run/secrets/better_auth_secret_previous'
			);
			expect(compose).toContain('file: ${BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE:-/dev/null}');
			expect(compose).toMatch(/^\s+- better_auth_secret_previous$/m);
			expect(compose).not.toMatch(/^\s+BETTER_AUTH_SECRET_PREVIOUS:\s/m);
		}
	);

	it.each(['scripts/deploy-vps.sh', 'scripts/rollback-vps.sh'])(
		'writes and mounts the optional secret without printing it in %s',
		(scriptFile) => {
			const script = projectFile(scriptFile);
			expect(script).toContain(
				'write_compose_secret_file better_auth_secret_previous BETTER_AUTH_SECRET_PREVIOUS optional'
			);
			expect(script).toContain(
				'upsert_env_var BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE ./secrets/better_auth_secret_previous'
			);
			expect(script).not.toMatch(/echo[^\n]*\$\{?BETTER_AUTH_SECRET_PREVIOUS/);
		}
	);

	it('threads the optional protected secret through generated VPS environments', () => {
		const workflow = projectFile('.github/workflows/deploy.yml');
		expect(workflow).toContain(
			'BETTER_AUTH_SECRET_PREVIOUS: ${{ secrets.BETTER_AUTH_SECRET_PREVIOUS }}'
		);
		expect(workflow).toContain(
			'write_env_var BETTER_AUTH_SECRET_PREVIOUS "${BETTER_AUTH_SECRET_PREVIOUS}"'
		);
		expect(projectFile('.env.example')).toContain(
			'BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE="/dev/null"'
		);
	});
});
