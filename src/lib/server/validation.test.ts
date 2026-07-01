import { describe, expect, it } from 'vitest';
import {
	authEmailSchema,
	auditFilterSchema,
	budgetAlertSchema,
	budgetSchema,
	categoryRuleSchema,
	categorySchema,
	dashboardFilterSchema,
	expenseCatalogSchema,
	expenseFilterSchema,
	expensePaymentSchema,
	expenseReviewSchema,
	expenseSchema,
	idSchema,
	importExpenseSchema,
	inviteSchema,
	isValidIsoDate,
	mfaCodeSchema,
	parseForm,
	passwordSchema,
	planningFilterSchema,
	recurringExpenseSchema,
	reportFilterSchema,
	resetPasswordSchema,
	roleSchema,
	signInSchema,
	signUpSchema,
	themePreferenceSchema,
	workspaceSchema
} from './validation';

describe('validation schemas', () => {
	it('coerces and rejects ids predictably', () => {
		expect(idSchema.parse('42')).toBe(42);
		expect(idSchema.safeParse('0').success).toBe(false);
		expect(idSchema.safeParse('1.5').success).toBe(false);
		expect(idSchema.safeParse('abc').success).toBe(false);
	});

	it('validates workspace data and applies defaults', () => {
		expect(workspaceSchema.parse({ name: '  Financeiro  ' })).toEqual({
			name: 'Financeiro',
			weekStartsOn: 1,
			currency: 'USD'
		});
		expect(workspaceSchema.parse({ name: 'Financeiro', currency: 'brl' }).currency).toBe('BRL');
		expect(workspaceSchema.safeParse({ name: 'A', weekStartsOn: 8 }).success).toBe(false);
	});

	it('validates category colors and business emojis', () => {
		expect(categorySchema.parse({ name: 'Limpeza', color: '#14b8a6', icon: '🧼' })).toEqual({
			name: 'Limpeza',
			color: '#14b8a6',
			icon: '🧼'
		});
		expect(categorySchema.parse({ name: 'Administrativo' }).icon).toBe('💼');
		expect(categorySchema.safeParse({ name: 'x', color: 'blue', icon: '❌' }).success).toBe(false);
	});

	it('validates expenses including BRL amount parsing rules', () => {
		const valid = expenseSchema.parse({
			categoryId: '7',
			description: 'Material de escritorio',
			amount: 'R$ 1.234,56',
			expenseDate: '2026-06-25',
			paymentMethodId: '9',
			vendorId: '10',
			costCenterId: '11',
			competencyMonth: '2026-06',
			notes: ''
		});

		expect(valid.categoryId).toBe(7);
		expect(valid.paymentMethodId).toBe(9);
		expect(valid.vendorId).toBe(10);
		expect(valid.costCenterId).toBe(11);
		expect(valid.installments).toBe(1);
		expect(valid.competencyMonth).toBe('2026-06-01');
		expect(expenseSchema.parse({ ...valid, installments: '12' }).installments).toBe(12);
		expect(expenseSchema.safeParse({ ...valid, paymentMethodId: 'Pix' }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...valid, amount: 'abc' }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...valid, amount: '0' }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...valid, installments: '121' }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...valid, expenseDate: '25/06/2026' }).success).toBe(false);
	});

	it('validates expense filters and report filters', () => {
		expect(isValidIsoDate('2026-02-28')).toBe(true);
		expect(isValidIsoDate('2026-02-31')).toBe(false);
		expect(
			expenseFilterSchema.parse({
				from: '2026-06-01',
				to: '2026-06-30',
				categoryId: '2',
				vendorId: '3',
				costCenterId: '4',
				competencyMonth: '2026-06',
				reviewStatus: 'pending',
				paymentStatus: 'unpaid',
				q: 'mercado',
				cursor: 'abc'
			})
		).toEqual({
			from: '2026-06-01',
			to: '2026-06-30',
			categoryId: 2,
			vendorId: 3,
			costCenterId: 4,
			competencyMonth: '2026-06-01',
			reviewStatus: 'pending',
			paymentStatus: 'unpaid',
			q: 'mercado',
			cursor: 'abc'
		});
		expect(expenseFilterSchema.safeParse({ reviewStatus: 'waiting' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ paymentStatus: 'late' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ vendorId: 'abc' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ costCenterId: '-1' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ competencyMonth: '2026-13' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ from: '01/06/2026' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ from: '2026-06-31' }).success).toBe(false);
		expect(expenseFilterSchema.safeParse({ from: '2026-07-01', to: '2026-06-01' }).success).toBe(
			false
		);
		expect(expenseFilterSchema.parse({ categoryId: '' }).categoryId).toBeUndefined();
		expect(
			expenseFilterSchema.parse({
				vendorId: '',
				costCenterId: '',
				competencyMonth: '',
				reviewStatus: '',
				paymentStatus: ''
			})
		).toEqual({});
		expect(reportFilterSchema.parse({ from: '2026-01-01', to: '2026-12-31' }).groupBy).toBe(
			'category'
		);
		expect(
			reportFilterSchema.parse({
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'payment'
			}).groupBy
		).toBe('payment');
		expect(
			reportFilterSchema.parse({
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'expense',
				vendorId: '10',
				costCenterId: '11',
				competencyMonth: '2026-06',
				reviewStatus: 'approved',
				paymentStatus: 'reconciled',
				q: ' fornecedor '
			})
		).toMatchObject({
			groupBy: 'expense',
			vendorId: 10,
			costCenterId: 11,
			competencyMonth: '2026-06-01',
			reviewStatus: 'approved',
			paymentStatus: 'reconciled',
			q: 'fornecedor'
		});
		expect(
			reportFilterSchema.safeParse({
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'day'
			}).success
		).toBe(false);
		expect(
			reportFilterSchema.safeParse({
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'expense',
				paymentStatus: 'late'
			}).success
		).toBe(false);
		expect(
			reportFilterSchema.safeParse({
				from: '2026-01-01',
				to: '2026-12-31',
				vendorId: 'abc'
			}).success
		).toBe(false);
		expect(
			reportFilterSchema.safeParse({
				from: '2026-01-01',
				to: '2026-12-31',
				competencyMonth: '2026-13'
			}).success
		).toBe(false);
		expect(dashboardFilterSchema.safeParse({ from: '2026-02-01', to: '2026-02-31' }).success).toBe(
			false
		);
		expect(reportFilterSchema.safeParse({ from: '2020-01-01', to: '2031-01-01' }).success).toBe(
			false
		);
		expect(planningFilterSchema.parse({ periodMonth: '' }).periodMonth).toBeUndefined();
		expect(planningFilterSchema.parse({ periodMonth: '2026-06' }).periodMonth).toBe('2026-06-01');
	});

	it('validates auth, invite, role and theme schemas', () => {
		expect(authEmailSchema.parse('USER@EXAMPLE.COM')).toBe('user@example.com');
		expect(passwordSchema.safeParse('short').success).toBe(false);
		expect(signInSchema.safeParse({ email: 'user@example.com', password: 'secret' }).success).toBe(
			true
		);
		expect(
			signUpSchema.safeParse({
				name: 'Test User',
				email: 'user@example.com',
				password: 'test-password-123'
			}).success
		).toBe(true);
		expect(
			resetPasswordSchema.safeParse({ token: 'x'.repeat(16), password: '1234567890' }).success
		).toBe(true);
		expect(inviteSchema.parse({ email: 'Admin@Example.com', role: 'viewer' })).toEqual({
			email: 'admin@example.com',
			role: 'viewer'
		});
		expect(roleSchema.safeParse('owner').success).toBe(true);
		expect(themePreferenceSchema.safeParse({ theme: 'dark' }).success).toBe(true);
		expect(themePreferenceSchema.safeParse({ theme: 'contrast' }).success).toBe(false);
	});

	it('validates planning, import, audit and mfa schemas', () => {
		expect(
			budgetSchema.parse({
				categoryId: '3',
				periodMonth: '2026-06',
				amount: '1.000,00',
				warningThresholdPct: '75'
			})
		).toMatchObject({ categoryId: 3, periodMonth: '2026-06-01', warningThresholdPct: 75 });
		expect(
			budgetSchema.safeParse({ categoryId: '3', periodMonth: '2026-13', amount: '10' }).success
		).toBe(false);
		expect(
			budgetSchema.safeParse({
				categoryId: '3',
				periodMonth: '2026-06-01',
				amount: 'abc'
			}).success
		).toBe(false);
		expect(
			recurringExpenseSchema.parse({
				categoryId: '3',
				description: 'Aluguel',
				amount: '2.000,00',
				frequency: 'monthly',
				intervalCount: '1',
				startDate: '2026-06-10',
				paymentMethodId: '4',
				endDate: ''
			})
		).toMatchObject({ paymentMethodId: 4, endDate: undefined });
		expect(expenseCatalogSchema.parse({ kind: 'vendor', name: ' ACME   Serviços ' })).toEqual({
			kind: 'vendor',
			name: 'ACME Serviços'
		});
		expect(
			expenseCatalogSchema.safeParse({ kind: 'paymentMethod', name: 'x'.repeat(81) }).success
		).toBe(false);
		expect(expenseCatalogSchema.safeParse({ kind: 'vendor', name: 'A' }).success).toBe(false);
		expect(
			recurringExpenseSchema.safeParse({
				categoryId: '3',
				description: 'Aluguel',
				amount: '2.000,00',
				startDate: '2026-06-10',
				endDate: '2026-06-09'
			}).success
		).toBe(false);
		expect(recurringExpenseSchema.safeParse({ description: 'x', amount: 'abc' }).success).toBe(
			false
		);
		expect(importExpenseSchema.parse({ sourceType: 'csv', defaultCategoryId: '' })).toEqual({
			sourceType: 'csv',
			defaultCategoryId: undefined
		});
		expect(
			categoryRuleSchema.parse({
				name: 'Pix limpeza',
				categoryId: '3',
				matchTarget: 'payment',
				pattern: 'pix',
				priority: '10'
			})
		).toEqual({
			name: 'Pix limpeza',
			categoryId: 3,
			matchTarget: 'payment',
			pattern: 'pix',
			priority: 10
		});
		expect(categoryRuleSchema.safeParse({ name: 'x', categoryId: '3', pattern: 'a' }).success).toBe(
			false
		);
		expect(
			expenseReviewSchema.parse({ id: '4', reviewStatus: 'rejected', reason: 'Duplicada' })
		).toEqual({
			id: 4,
			reviewStatus: 'rejected',
			reason: 'Duplicada'
		});
		expect(
			expenseReviewSchema.safeParse({ id: '4', reviewStatus: 'rejected', reason: '' }).success
		).toBe(false);
		expect(expenseReviewSchema.safeParse({ id: '4', reviewStatus: 'pending' }).success).toBe(false);
		expect(expensePaymentSchema.parse({ id: '4', paymentStatus: 'paid', paidAt: '' })).toEqual({
			id: 4,
			paymentStatus: 'paid',
			paidAt: undefined
		});
		expect(expensePaymentSchema.safeParse({ id: '4', paymentStatus: 'late' }).success).toBe(false);
		expect(budgetAlertSchema.parse({ periodMonth: '2026-06' })).toEqual({
			periodMonth: '2026-06-01'
		});
		expect(auditFilterSchema.parse({ action: 'expense.created', cursor: 'abc' })).toEqual({
			action: 'expense.created',
			cursor: 'abc'
		});
		expect(mfaCodeSchema.safeParse({ code: '123456' }).success).toBe(true);
	});

	it('parses FormData through the provided schema', () => {
		const formData = new FormData();
		formData.set('name', '  Novo workspace  ');
		formData.set('weekStartsOn', '0');

		const parsed = parseForm(formData, workspaceSchema);

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).toEqual({
				currency: 'USD',
				name: 'Novo workspace',
				weekStartsOn: 0
			});
		}
	});
});
