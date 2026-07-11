import { fail, isHttpError } from '@sveltejs/kit';
import { translate, type SupportedLocale } from '$lib/i18n';
import type { ZodError } from 'zod';

/**
 * Handles an HttpError thrown from a service call by converting it into a
 * SvelteKit `fail()` response so the form can surface the message inline.
 *
 * Only handles errors whose status is below 500 (client errors). Server
 * errors are re-thrown so the global error boundary can catch them.
 *
 * Pass `only409: true` when you only want to intercept optimistic-concurrency
 * conflicts (409) and let all other client errors propagate normally.
 */
export function handleServiceError(
	err: unknown,
	extra: Record<string, unknown> = {},
	options: { only409?: boolean; exclude403?: boolean } = {}
): ReturnType<typeof fail> {
	if (isHttpError(err)) {
		const { status } = err;
		const message: string = err.body.message;

		if (options.only409 && status !== 409) throw err;
		if (options.exclude403 && status === 403) throw err;
		if (status >= 500) throw err;

		return fail(status, { message, ...extra });
	}
	throw err;
}

/**
 * Extracts form values for the expense create form so the UI can repopulate
 * fields after a validation failure without duplicating the field list.
 */
export function expenseFormValues(formData: FormData) {
	return {
		description: (formData.get('description') as string) ?? '',
		amount: (formData.get('amount') as string) ?? '',
		expenseDate: (formData.get('expenseDate') as string) ?? '',
		categoryId: (formData.get('categoryId') as string) ?? '',
		paymentMethodId: (formData.get('paymentMethodId') as string) ?? '',
		vendorId: formData.get('vendorId') ? Number(formData.get('vendorId')) : null,
		costCenterId: formData.get('costCenterId') ? Number(formData.get('costCenterId')) : null,
		competencyMonth: (formData.get('competencyMonth') as string) ?? '',
		installments: (formData.get('installments') as string) ?? '1',
		notes: (formData.get('notes') as string) ?? ''
	};
}

export function budgetFormValues(formData: FormData) {
	return {
		categoryId: (formData.get('categoryId') as string) ?? '',
		amount: (formData.get('amount') as string) ?? '',
		warningThresholdPct: (formData.get('warningThresholdPct') as string) ?? '80'
	};
}

export function localizedFormFieldErrors(error: ZodError, locale: SupportedLocale | string) {
	const fieldErrors: Record<string, string> = {};
	for (const issue of error.issues) {
		const pathHead = issue.path[0];
		if (typeof pathHead !== 'string' && typeof pathHead !== 'number') continue;
		const field = String(pathHead);
		fieldErrors[field] ??= translate(locale, issue.message);
	}
	return fieldErrors;
}
