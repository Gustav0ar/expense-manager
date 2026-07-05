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
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: [
				'src/lib/category-emojis.ts',
				'src/lib/server/email.ts',
				'src/lib/server/registration.ts',
				'src/lib/server/security/client-ip.ts',
				'src/lib/server/security/origin.ts',
				'src/lib/server/security/roles.ts',
				'src/lib/server/theme.ts',
				'src/lib/server/services/budgets.ts',
				'src/lib/server/services/category-rules.ts',
				'src/lib/server/services/expenses.ts',
				'src/lib/server/services/imports.ts',
				'src/lib/server/services/invitations.ts',
				'src/lib/server/utils/*.ts',
				'src/lib/server/utils/import.ts',
				'src/lib/server/utils/totp.ts',
				'src/lib/server/validation.ts',
				'src/lib/utils/date-format.ts',
				'src/lib/utils/format.ts'
			],
			exclude: ['src/**/*.test.ts'],
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 90,
				statements: 90
			}
		}
	}
});
