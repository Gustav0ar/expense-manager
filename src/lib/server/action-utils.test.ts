import { error, isActionFailure } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	budgetFormValues,
	expenseFormValues,
	handleServiceError,
	localizedFormFieldErrors
} from './action-utils';

describe('server action utilities', () => {
	it('maps handled client errors to action failures with preserved values', () => {
		const result = handleServiceError(httpError(400, 'Invalid input.'), {
			values: { amount: '12.00' }
		});
		expect(isActionFailure(result)).toBe(true);
		expect(result).toMatchObject({
			status: 400,
			data: { message: 'Invalid input.', values: { amount: '12.00' } }
		});
		expect(handleServiceError(httpError(409, 'Conflict.'), {}, { only409: true })).toMatchObject({
			status: 409
		});
	});

	it('rethrows server, excluded authorization, non-conflict and non-HTTP errors', () => {
		const serverError = httpError(500, 'Server error');
		const forbidden = httpError(403, 'Forbidden');
		const validation = httpError(400, 'Validation');
		const plain = new Error('plain');
		expect(() => handleServiceError(serverError)).toThrow(serverError);
		expect(() => handleServiceError(forbidden, {}, { exclude403: true })).toThrow(forbidden);
		expect(() => handleServiceError(validation, {}, { only409: true })).toThrow(validation);
		expect(() => handleServiceError(plain)).toThrow(plain);
	});

	it('extracts only the supported expense form fields with safe defaults', () => {
		const populated = new FormData();
		populated.set('description', 'Taxi');
		populated.set('amount', '25.90');
		populated.set('expenseDate', '2026-07-01');
		populated.set('categoryId', '4');
		populated.set('paymentMethodId', '5');
		populated.set('vendorId', '6');
		populated.set('costCenterId', '7');
		populated.set('competencyMonth', '2026-07');
		populated.set('installments', '3');
		populated.set('notes', 'Airport');
		populated.set('unexpected', 'secret');
		expect(expenseFormValues(populated)).toEqual({
			description: 'Taxi',
			amount: '25.90',
			expenseDate: '2026-07-01',
			categoryId: '4',
			paymentMethodId: '5',
			vendorId: 6,
			costCenterId: 7,
			competencyMonth: '2026-07',
			installments: '3',
			notes: 'Airport'
		});
		expect(expenseFormValues(new FormData())).toEqual({
			description: '',
			amount: '',
			expenseDate: '',
			categoryId: '',
			paymentMethodId: '',
			vendorId: null,
			costCenterId: null,
			competencyMonth: '',
			installments: '1',
			notes: ''
		});
	});

	it('preserves budget fields and localizes validation errors', () => {
		const populated = new FormData();
		populated.set('categoryId', '4');
		populated.set('amount', '1000000000.01');
		populated.set('warningThresholdPct', '73');
		populated.set('unexpected', 'secret');
		expect(budgetFormValues(populated)).toEqual({
			categoryId: '4',
			amount: '1000000000.01',
			warningThresholdPct: '73'
		});
		expect(budgetFormValues(new FormData())).toEqual({
			categoryId: '',
			amount: '',
			warningThresholdPct: '80'
		});

		const parsed = z
			.object({ amount: z.string().refine(() => false, 'Amount exceeds the maximum allowed.') })
			.safeParse({ amount: 'too-high' });
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(localizedFormFieldErrors(parsed.error, 'pt-BR')).toEqual({
				amount: 'Valor excede o máximo permitido.'
			});
		}
	});
});

function httpError(status: 400 | 403 | 409 | 500, message: string) {
	try {
		error(status, message);
	} catch (thrown) {
		return thrown;
	}
	throw new Error('SvelteKit error() did not throw');
}
