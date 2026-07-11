import { z } from 'zod';
import { categoryEmojiValues } from '$lib/category-emojis';
import { defaultCurrency, isValidCurrencyCode } from '$lib/i18n';
import { amountExceedsMaximumMessage, parseCurrencyToCents } from '$lib/server/utils/money';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxRangeDays = 3660;

export const idSchema = z.coerce.number().int().positive();
const optionalIdSchema = z.preprocess(
	(value) => (value === '' ? undefined : value),
	idSchema.optional()
);
const optionalTrimmedText = (max: number) =>
	z.string().trim().max(max).optional().or(z.literal(''));
const moneyAmountSchema = z
	.string()
	.trim()
	.min(1, { message: 'Amount is required.' })
	.max(32, { message: 'Amount is invalid.' })
	.superRefine((value, context) => {
		try {
			parseCurrencyToCents(value);
		} catch (moneyError) {
			context.addIssue({
				code: 'custom',
				message:
					moneyError instanceof Error && moneyError.message === amountExceedsMaximumMessage
						? amountExceedsMaximumMessage
						: 'Amount is invalid.'
			});
		}
	});
const normalizedCatalogName = z
	.string()
	.trim()
	.min(2)
	.max(120)
	.refine((value) => !hasControlCharacters(value), {
		message: 'Name cannot contain control characters.'
	})
	.transform((value) => value.replace(/\s+/g, ' '));

function hasControlCharacters(value: string) {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

export function isValidIsoDate(value: string) {
	const match = datePattern.exec(value);
	if (!match) return false;

	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

export const isoDateSchema = z
	.string()
	.regex(datePattern)
	.refine(isValidIsoDate, { message: 'Invalid date.' });

const optionalDateSchema = z.preprocess(
	(value) => (value === '' ? undefined : value),
	isoDateSchema.optional()
);
const optionalReviewStatusSchema = z.preprocess(
	(value) => (value === '' ? undefined : value),
	z.enum(['pending', 'approved', 'rejected']).optional()
);
const optionalPaymentStatusSchema = z.preprocess(
	(value) => (value === '' ? undefined : value),
	z.enum(['unpaid', 'paid', 'reconciled']).optional()
);
const monthSchema = z.preprocess((value) => {
	if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
	return value;
}, isoDateSchema);
const optionalMonthSchema = z
	.preprocess((value) => {
		if (value === '') return undefined;
		if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
		return value;
	}, isoDateSchema.optional())
	.refine((v) => v === undefined || v.endsWith('-01'), {
		message: 'Must be the first day of a month (YYYY-MM or YYYY-MM-01).'
	});

function validateDateRange(values: { from?: string; to?: string }, context: z.RefinementCtx) {
	if (values.from && values.to && values.from > values.to) {
		context.addIssue({
			code: 'custom',
			path: ['to'],
			message: 'End date must be greater than or equal to start date.'
		});
	}

	if (values.from && values.to && daysBetween(values.from, values.to) > maxRangeDays) {
		context.addIssue({
			code: 'custom',
			path: ['to'],
			message: 'Maximum allowed range is 10 years.'
		});
	}
}

function daysBetween(from: string, to: string) {
	const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
	const [toYear, toMonth, toDay] = to.split('-').map(Number);
	const fromDate = Date.UTC(fromYear, fromMonth - 1, fromDay);
	const toDate = Date.UTC(toYear, toMonth - 1, toDay);
	return Math.floor((toDate - fromDate) / 86_400_000);
}

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const assignableRoleSchema = z.enum(['admin', 'member', 'viewer']);
export const themePreferenceSchema = z.object({
	theme: z.enum(['system', 'light', 'dark'])
});

export const localePreferenceSchema = z.object({
	locale: z.enum(['system', 'en', 'pt-BR'])
});

const currencySchema = z
	.string()
	.trim()
	.toUpperCase()
	.refine(isValidCurrencyCode, { message: 'Currency is invalid.' });

export const workspaceSchema = z.object({
	name: z.string().trim().min(2).max(80),
	weekStartsOn: z.coerce.number().int().min(0).max(6).default(1),
	currency: currencySchema.default(defaultCurrency)
});

export const categorySchema = z.object({
	name: z.string().trim().min(2).max(80),
	color: z
		.string()
		.trim()
		.regex(/^#[0-9A-Fa-f]{6}$/)
		.default('#2563eb'),
	icon: z.enum(categoryEmojiValues).default('💼')
});

export const expenseCatalogSchema = z
	.object({
		kind: z.enum(['paymentMethod', 'vendor', 'costCenter']),
		name: normalizedCatalogName
	})
	.superRefine((value, context) => {
		if (value.kind === 'paymentMethod' && value.name.length > 80) {
			context.addIssue({
				code: 'custom',
				path: ['name'],
				message: 'Payment must be at most 80 characters.'
			});
		}
	});

export const expenseCatalogUpdateSchema = expenseCatalogSchema.extend({
	id: idSchema
});

export const expenseCatalogArchiveSchema = z.object({
	kind: z.enum(['paymentMethod', 'vendor', 'costCenter']),
	id: idSchema
});

export const expenseSchema = z.object({
	categoryId: idSchema,
	description: z.string().trim().min(2).max(160),
	amount: moneyAmountSchema,
	expenseDate: isoDateSchema,
	paymentMethodId: optionalIdSchema,
	vendorId: optionalIdSchema,
	costCenterId: optionalIdSchema,
	competencyMonth: optionalMonthSchema,
	notes: optionalTrimmedText(1000),
	installments: z.coerce.number().int().min(1).max(120).default(1)
});

export const expenseFilterSchema = z
	.object({
		from: optionalDateSchema,
		to: optionalDateSchema,
		categoryId: optionalIdSchema,
		vendorId: optionalIdSchema,
		costCenterId: optionalIdSchema,
		competencyMonth: optionalMonthSchema,
		reviewStatus: optionalReviewStatusSchema,
		paymentStatus: optionalPaymentStatusSchema,
		q: z.string().trim().max(120).optional(),
		cursor: z.string().trim().max(500).optional()
	})
	.superRefine(validateDateRange);

export const reportFilterSchema = z
	.object({
		from: isoDateSchema,
		to: isoDateSchema,
		groupBy: z
			.enum(['category', 'week', 'month', 'year', 'payment', 'vendor', 'costCenter', 'expense'])
			.default('category'),
		dateField: z.enum(['expenseDate', 'competencyMonth']).default('expenseDate'),
		categoryId: optionalIdSchema,
		vendorId: optionalIdSchema,
		costCenterId: optionalIdSchema,
		competencyMonth: optionalMonthSchema,
		reviewStatus: optionalReviewStatusSchema,
		paymentStatus: optionalPaymentStatusSchema,
		q: z.string().trim().max(120).optional()
	})
	.superRefine(validateDateRange);

export const dashboardFilterSchema = z
	.object({
		from: isoDateSchema,
		to: isoDateSchema
	})
	.superRefine(validateDateRange);

export const planningFilterSchema = z.object({
	periodMonth: optionalMonthSchema
});

export const budgetSchema = z.object({
	categoryId: idSchema,
	periodMonth: monthSchema,
	amount: moneyAmountSchema,
	warningThresholdPct: z.coerce.number().int().min(1).max(100).default(80)
});

export const recurringExpenseSchema = z
	.object({
		categoryId: idSchema,
		description: z.string().trim().min(2).max(160),
		amount: moneyAmountSchema,
		frequency: z.enum(['weekly', 'monthly', 'yearly']).default('monthly'),
		intervalCount: z.coerce.number().int().min(1).max(24).default(1),
		startDate: isoDateSchema,
		endDate: z.preprocess((value) => (value === '' ? undefined : value), isoDateSchema.optional()),
		paymentMethodId: optionalIdSchema,
		notes: z.string().trim().max(1000).optional().or(z.literal(''))
	})
	.superRefine((values, context) => {
		if (values.endDate && values.endDate < values.startDate) {
			context.addIssue({
				code: 'custom',
				path: ['endDate'],
				message: 'End date must be greater than or equal to start date.'
			});
		}
	});

export const importExpenseSchema = z.object({
	sourceType: z.enum(['csv', 'ofx']),
	defaultCategoryId: z.preprocess(
		(value) => (value === '' ? undefined : value),
		idSchema.optional()
	)
});

export const confirmImportPreviewSchema = z.object({
	previewId: idSchema,
	sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/)
});

export const undoImportBatchSchema = z.object({ batchId: idSchema });

export const categoryRuleSchema = z.object({
	name: z.string().trim().min(2).max(80),
	categoryId: idSchema,
	matchTarget: z.enum(['description', 'vendor', 'payment']).default('description'),
	pattern: z.string().trim().min(2).max(120),
	priority: z.coerce.number().int().min(1).max(1000).default(100)
});

export const expenseReviewSchema = z
	.object({
		id: idSchema,
		reviewStatus: z.enum(['approved', 'rejected']),
		reason: optionalTrimmedText(500)
	})
	.superRefine((values, context) => {
		if (values.reviewStatus === 'rejected' && !values.reason?.trim()) {
			context.addIssue({
				code: 'custom',
				path: ['reason'],
				message: 'Rejection reason is required.'
			});
		}
	});

export const expensePaymentSchema = z.object({
	id: idSchema,
	paymentStatus: z.enum(['unpaid', 'paid', 'reconciled']),
	paidAt: z.preprocess((value) => (value === '' ? undefined : value), isoDateSchema.optional())
});

export const budgetAlertSchema = z.object({
	periodMonth: monthSchema
});

export const budgetAlertPreferenceSchema = z.object({
	enabled: z.enum(['true', 'false']).transform((value) => value === 'true')
});

export const auditFilterSchema = z.object({
	action: z.string().trim().max(120).optional(),
	entityType: z.string().trim().max(80).optional(),
	cursor: z.string().trim().max(500).optional()
});

export const mfaCodeSchema = z.object({
	code: z.string().trim().min(6).max(32)
});

export const authEmailSchema = z.string().trim().email().max(254).toLowerCase();
export const passwordSchema = z.string().min(10).max(128);

export const signInSchema = z.object({
	email: authEmailSchema,
	password: z.string().min(1).max(128)
});

export const signUpSchema = z
	.object({
		name: z.string().trim().min(2).max(80),
		email: authEmailSchema,
		password: passwordSchema,
		passwordConfirmation: z.string().min(1).max(128)
	})
	.superRefine((values, context) => {
		if (values.password !== values.passwordConfirmation) {
			context.addIssue({
				code: 'custom',
				path: ['passwordConfirmation'],
				message: 'Passwords do not match.'
			});
		}
	});

export const forgotPasswordSchema = z.object({
	email: authEmailSchema
});

export const resetPasswordSchema = z.object({
	token: z.string().trim().min(16).max(500),
	password: passwordSchema
});

export const inviteSchema = z.object({
	email: authEmailSchema,
	role: assignableRoleSchema
});

export function parseForm<T>(formData: FormData, schema: z.ZodType<T>) {
	const values = Object.fromEntries(formData.entries());
	return schema.safeParse(values);
}
