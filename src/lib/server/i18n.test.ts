import { describe, expect, it } from 'vitest';
import { internalErrorMessage } from './i18n';

describe('server error localization', () => {
	it('localizes generic internal errors without exposing implementation details', () => {
		expect(internalErrorMessage('en')).toBe('Internal error.');
		expect(internalErrorMessage('pt-BR')).toBe('Erro interno.');
		expect(internalErrorMessage(undefined)).toBe('Internal error.');
	});
});
