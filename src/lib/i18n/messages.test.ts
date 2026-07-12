import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ptBrMessages } from './messages';

describe('pt-BR message coverage', () => {
	it('contains every literal key emitted by production translation calls', () => {
		const keys = new Set<string>();
		const paths = [
			...globSync('src/**/*.ts', {
				exclude: ['src/**/*.test.ts', 'src/**/*.e2e.ts', 'src/**/*.d.ts']
			}),
			...globSync('src/**/*.svelte')
		];

		for (const path of paths) {
			const source = readFileSync(path, 'utf8');
			for (const match of source.matchAll(/\bt\(\s*(['"])(.*?)\1/g)) keys.add(match[2]);
			for (const match of source.matchAll(/\btranslate\(\s*[^,]+,\s*(['"])(.*?)\1/g)) {
				keys.add(match[2]);
			}
		}

		const missing = [...keys].filter((key) => !(key in ptBrMessages)).sort();
		expect(missing).toEqual([]);
	});
});
