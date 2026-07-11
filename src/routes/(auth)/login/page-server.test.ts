import { describe, expect, it, vi } from 'vitest';
import { actions } from './+page.server';

vi.mock('$lib/server/auth', () => ({
	auth: { api: {} }
}));

function createEvent(fields: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		formData.set(key, value);
	}

	return {
		request: new Request('http://localhost/login', {
			method: 'POST',
			body: formData,
			headers: new Headers({ 'x-sveltekit-action': 'true' })
		}),
		locals: { locale: 'en' }
	} as Parameters<NonNullable<typeof actions.default>>[0];
}

describe('login page action', () => {
	it('returns only allowlisted fields after validation fails', async () => {
		const action = actions.default;
		if (!action) throw new Error('default action is not registered');

		const password = ['response', 'secret', 'must', 'not', 'leak'].join('-');
		const result = await action(
			createEvent({
				email: 'invalid-email',
				password,
				next: '//evil.example/app'
			})
		);

		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Check email and password.',
				values: { email: 'invalid-email', next: '/app' }
			}
		});
		if (!result || !('data' in result)) throw new Error('Expected a failed action response');
		expect(Object.keys(result.data.values)).toEqual(['email', 'next']);
		expect(JSON.stringify(result)).not.toContain(password);
	});
});
