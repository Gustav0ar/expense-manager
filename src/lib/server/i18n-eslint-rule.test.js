import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { requireTranslatedServerMessages } from '../../../eslint-rules/i18n-server-messages.js';

/** @type {any[]} */
const config = [
	{
		languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
		plugins: {
			'i18n-local': {
				rules: { 'require-translated-server-messages': requireTranslatedServerMessages }
			}
		},
		rules: { 'i18n-local/require-translated-server-messages': 'error' }
	}
];

/** @param {string} code */
function verify(code) {
	return new Linter({ configType: 'flat' }).verify(
		`async function action() { ${code} }`,
		config,
		'fixture.server.js'
	);
}

describe('require-translated-server-messages', () => {
	it.each([
		"throw error(403, translate(locale, 'Permission denied.'));",
		"return fail(400, { message: translate(locale, 'Check the form.') });",
		"if (caught.message === 'PROVIDER_PROTOCOL_VALUE') return null;",
		"console.error('Background job failed', caught.message);",
		'return fail(422, { message: caught.body.message });',
		"return fail(400, { code: 'PROTOCOL_ERROR' });"
	])('accepts translated, protocol or technical fixture: %s', (code) => {
		expect(verify(code)).toEqual([]);
	});

	it.each([
		["throw error(403, 'Permission denied.');", 'literal'],
		["return fail(400, { message: 'Check the form.' });", 'literal'],
		['return fail(400, { message: `Check the form.` });', 'literal'],
		[
			'try { await provider(); } catch (providerError) { return fail(400, { message: providerError.message }); }',
			'provider'
		],
		[
			"try { await provider(); } catch (providerError) { return fail(400, { message: providerError.message || translate(locale, 'Fallback.') }); }",
			'provider'
		]
	])('rejects untranslated fixture: %s', (code, messageId) => {
		expect(verify(code)).toEqual([
			expect.objectContaining({
				ruleId: 'i18n-local/require-translated-server-messages',
				messageId
			})
		]);
	});
});
