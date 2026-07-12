import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				config: (config) => ({
					...config,
					include: [...config.include, '../drizzle.config.ts']
				})
			},
			// Let SvelteKit auto-nonce its inline hydration scripts so the strict
			// script-src CSP policy doesn't block them in production.
			csp: {
				mode: 'nonce',
				directives: {
					'default-src': ['self'],
					// SvelteKit adds the nonce automatically when mode is 'nonce'.
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'frame-ancestors': ['none'],
					'base-uri': ['self'],
					'form-action': ['self']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'tests/playwright/**/*.{test,spec}.ts'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/lib/server/**/*.ts', 'src/lib/category-emojis.ts', 'src/lib/utils/**/*.ts'],
			exclude: [
				// Tests verify production modules but are not themselves product behavior.
				'src/**/*.{test,spec}.ts',
				// Domain scenario modules are imported by the service integration test entry point.
				'src/lib/server/services/service-integration/**/*.ts',
				// Declarative Drizzle schemas contain table metadata rather than executable behavior.
				'src/lib/server/db/*.schema.ts',
				'src/lib/server/db/schema.ts',
				// Database and authentication bootstraps are framework composition entry points.
				'src/lib/server/db/index.ts',
				'src/lib/server/auth.ts'
			],
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 90,
				statements: 90
			}
		}
	}
});
