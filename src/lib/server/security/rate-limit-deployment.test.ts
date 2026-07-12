import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const variables = [
	'AUTH_RATE_LIMIT_IDENTIFIER_MAX',
	'AUTH_RATE_LIMIT_IP_MAX',
	'AUTH_RATE_LIMIT_WINDOW_SECONDS'
];

describe('authentication rate-limit deployment configuration', () => {
	it('passes optional overrides through both production Compose variants', () => {
		for (const composeFile of ['docker-compose.yml', 'docker-compose.traefik.yml']) {
			const compose = readFileSync(composeFile, 'utf8');
			for (const variable of variables) {
				expect(compose).toContain(`${variable}: \${${variable}:-}`);
			}
		}
	});

	it('writes reviewed GitHub environment overrides without making them required', () => {
		const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
		for (const variable of variables) {
			expect(workflow).toContain(`${variable}: \${{ vars.${variable} || '' }}`);
			expect(workflow).toContain(`write_env_var ${variable} "\${${variable}}"`);
		}
	});
});
