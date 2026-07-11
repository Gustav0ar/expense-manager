import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const criticalServices = [
	'attachments.ts',
	'categories.ts',
	'expense-catalogs.ts',
	'mfa.ts',
	'workspaces.ts'
];

describe('server coverage configuration', () => {
	it('automatically includes every critical service without service-specific exclusions', () => {
		const config = readFileSync('vite.config.ts', 'utf8');
		expect(config).toContain("'src/lib/server/**/*.ts'");
		for (const file of criticalServices) {
			expect(config).not.toContain(`'src/lib/server/services/${file}'`);
			expect(readFileSync(`src/lib/server/services/${file}`, 'utf8').length).toBeGreaterThan(0);
		}
		expect(config).not.toContain("'src/lib/server/services/**/*.ts'");
	});

	it('retains all four global 90 percent thresholds', () => {
		const config = readFileSync('vite.config.ts', 'utf8');
		for (const metric of ['lines', 'functions', 'branches', 'statements']) {
			expect(config).toContain(`${metric}: 90`);
		}
	});
});
