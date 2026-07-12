import { safeInternalPath } from '$lib/server/security/internal-redirect';

export function safeExpensesReturnTo(value: FormDataEntryValue | null) {
	const path = safeInternalPath(value?.toString(), '/app/expenses');
	return path.startsWith('/app/expenses') && !path.startsWith('//') ? path : '/app/expenses';
}

export function isEnhancedAction(event: { request: Request }) {
	return event.request.headers.get('x-sveltekit-action') === 'true';
}
