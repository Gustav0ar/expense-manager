import { relations, sql } from 'drizzle-orm';
import {
	bigint,
	bigserial,
	boolean,
	char,
	check,
	date,
	index,
	integer,
	type AnyPgColumn,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { session, user } from './auth.schema';

export type ImportBatchFailedRow = {
	rowNumber: number;
	message: string;
};

export const workspace = pgTable(
	'workspace',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		name: text('name').notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		weekStartsOn: integer('week_starts_on').notNull().default(1),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('workspace_currency_check', sql`${table.currency} = upper(${table.currency})`),
		check('workspace_week_starts_on_check', sql`${table.weekStartsOn} between 0 and 6`),
		index('workspace_created_by_user_id_idx').on(table.createdByUserId)
	]
);

export const workspaceMember = pgTable(
	'workspace_member',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role').notNull(),
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check(
			'workspace_member_role_check',
			sql`${table.role} in ('owner', 'admin', 'member', 'viewer')`
		),
		check('workspace_member_status_check', sql`${table.status} in ('active', 'disabled')`),
		uniqueIndex('workspace_member_workspace_user_unique_idx').on(table.workspaceId, table.userId),
		index('workspace_member_user_workspace_idx').on(table.userId, table.workspaceId),
		index('workspace_member_workspace_idx').on(table.workspaceId)
	]
);

export const workspaceInvitation = pgTable(
	'workspace_invitation',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		email: text('email').notNull(),
		role: text('role').notNull().default('member'),
		tokenHash: text('token_hash').notNull().unique(),
		status: text('status').notNull().default('pending'),
		invitedByUserId: text('invited_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		acceptedAt: timestamp('accepted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		check('workspace_invitation_role_check', sql`${table.role} in ('admin', 'member', 'viewer')`),
		check(
			'workspace_invitation_status_check',
			sql`${table.status} in ('pending', 'accepted', 'revoked', 'expired')`
		),
		uniqueIndex('workspace_invitation_pending_email_unique_idx')
			.on(table.workspaceId, sql`lower(${table.email})`)
			.where(sql`${table.status} = 'pending'`),
		index('workspace_invitation_workspace_idx').on(table.workspaceId),
		index('workspace_invitation_email_idx').on(table.email),
		index('workspace_invitation_expires_at_idx').on(table.expiresAt)
	]
);

export const category = pgTable(
	'category',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		color: text('color').notNull().default('#2563eb'),
		icon: text('icon'),
		parentCategoryId: bigint('parent_category_id', { mode: 'number' }).references(
			(): AnyPgColumn => category.id,
			{ onDelete: 'set null' }
		),
		isArchived: boolean('is_archived').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		index('category_workspace_idx').on(table.workspaceId),
		index('category_parent_category_id_idx').on(table.parentCategoryId),
		uniqueIndex('category_workspace_name_unique_idx')
			.on(table.workspaceId, sql`lower(${table.name})`)
			.where(sql`${table.isArchived} = false`),
		check('category_color_check', sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`)
	]
);

export const paymentMethod = pgTable(
	'payment_method',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		isArchived: boolean('is_archived').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('payment_method_name_check', sql`length(btrim(${table.name})) between 2 and 80`),
		uniqueIndex('payment_method_workspace_name_unique_idx').on(
			table.workspaceId,
			sql`lower(${table.name})`
		),
		index('payment_method_workspace_active_idx').on(table.workspaceId, table.isArchived, table.name)
	]
);

export const vendor = pgTable(
	'vendor',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		isArchived: boolean('is_archived').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('vendor_name_check', sql`length(btrim(${table.name})) between 2 and 120`),
		uniqueIndex('vendor_workspace_name_unique_idx').on(
			table.workspaceId,
			sql`lower(${table.name})`
		),
		index('vendor_workspace_active_idx').on(table.workspaceId, table.isArchived, table.name)
	]
);

export const costCenter = pgTable(
	'cost_center',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		isArchived: boolean('is_archived').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('cost_center_name_check', sql`length(btrim(${table.name})) between 2 and 120`),
		uniqueIndex('cost_center_workspace_name_unique_idx').on(
			table.workspaceId,
			sql`lower(${table.name})`
		),
		index('cost_center_workspace_active_idx').on(table.workspaceId, table.isArchived, table.name)
	]
);

export const categoryBudget = pgTable(
	'category_budget',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		categoryId: bigint('category_id', { mode: 'number' })
			.notNull()
			.references(() => category.id, { onDelete: 'cascade' }),
		periodMonth: date('period_month', { mode: 'string' }).notNull(),
		amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
		warningThresholdPct: integer('warning_threshold_pct').notNull().default(80),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('category_budget_amount_cents_check', sql`${table.amountCents} > 0`),
		check(
			'category_budget_warning_threshold_check',
			sql`${table.warningThresholdPct} between 1 and 100`
		),
		check('category_budget_period_month_check', sql`extract(day from ${table.periodMonth}) = 1`),
		uniqueIndex('category_budget_workspace_category_month_unique_idx').on(
			table.workspaceId,
			table.categoryId,
			table.periodMonth
		),
		index('category_budget_workspace_month_idx').on(table.workspaceId, table.periodMonth),
		index('category_budget_category_idx').on(table.categoryId),
		index('category_budget_created_by_idx').on(table.createdByUserId)
	]
);

export const categoryRule = pgTable(
	'category_rule',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		categoryId: bigint('category_id', { mode: 'number' })
			.notNull()
			.references(() => category.id, { onDelete: 'cascade' }),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		name: text('name').notNull(),
		matchTarget: text('match_target').notNull().default('description'),
		pattern: text('pattern').notNull(),
		priority: integer('priority').notNull().default(100),
		isActive: boolean('is_active').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check(
			'category_rule_target_check',
			sql`${table.matchTarget} in ('description', 'vendor', 'payment')`
		),
		check('category_rule_priority_check', sql`${table.priority} between 1 and 1000`),
		uniqueIndex('category_rule_workspace_name_unique_idx')
			.on(table.workspaceId, sql`lower(${table.name})`)
			.where(sql`${table.isActive} = true`),
		index('category_rule_workspace_active_priority_idx')
			.on(table.workspaceId, table.priority, table.id)
			.where(sql`${table.isActive} = true`),
		index('category_rule_category_idx').on(table.categoryId),
		index('category_rule_created_by_idx').on(table.createdByUserId)
	]
);

export const recurringExpense = pgTable(
	'recurring_expense',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		categoryId: bigint('category_id', { mode: 'number' })
			.notNull()
			.references(() => category.id, { onDelete: 'restrict' }),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		description: text('description').notNull(),
		amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		frequency: text('frequency').notNull().default('monthly'),
		intervalCount: integer('interval_count').notNull().default(1),
		startDate: date('start_date', { mode: 'string' }).notNull(),
		nextRunDate: date('next_run_date', { mode: 'string' }).notNull(),
		endDate: date('end_date', { mode: 'string' }),
		paymentMethod: text('payment_method'),
		paymentMethodId: bigint('payment_method_id', { mode: 'number' }).references(
			() => paymentMethod.id,
			{ onDelete: 'set null' }
		),
		notes: text('notes'),
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		check('recurring_expense_amount_cents_check', sql`${table.amountCents} > 0`),
		check(
			'recurring_expense_frequency_check',
			sql`${table.frequency} in ('weekly', 'monthly', 'yearly')`
		),
		check('recurring_expense_interval_count_check', sql`${table.intervalCount} between 1 and 24`),
		check('recurring_expense_status_check', sql`${table.status} in ('active', 'paused')`),
		index('recurring_expense_workspace_next_run_idx')
			.on(table.workspaceId, table.nextRunDate)
			.where(sql`${table.status} = 'active'`),
		index('recurring_expense_workspace_idx').on(table.workspaceId),
		index('recurring_expense_category_idx').on(table.categoryId),
		index('recurring_expense_payment_method_idx').on(table.paymentMethodId),
		index('recurring_expense_created_by_idx').on(table.createdByUserId)
	]
);

export const importBatch = pgTable(
	'import_batch',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		uploadedByUserId: text('uploaded_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		sourceType: text('source_type').notNull(),
		fileName: text('file_name').notNull(),
		rowCount: integer('row_count').notNull().default(0),
		importedCount: integer('imported_count').notNull().default(0),
		failedCount: integer('failed_count').notNull().default(0),
		failedRows: jsonb('failed_rows')
			.$type<ImportBatchFailedRow[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		check('import_batch_source_type_check', sql`${table.sourceType} in ('csv', 'ofx')`),
		index('import_batch_workspace_created_idx').on(table.workspaceId, table.createdAt),
		index('import_batch_uploaded_by_idx').on(table.uploadedByUserId)
	]
);

export const expense = pgTable(
	'expense',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		categoryId: bigint('category_id', { mode: 'number' })
			.notNull()
			.references(() => category.id, { onDelete: 'restrict' }),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		description: text('description').notNull(),
		amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		expenseDate: date('expense_date', { mode: 'string' }).notNull(),
		paymentMethod: text('payment_method'),
		vendor: text('vendor'),
		costCenter: text('cost_center'),
		paymentMethodId: bigint('payment_method_id', { mode: 'number' }).references(
			() => paymentMethod.id,
			{ onDelete: 'set null' }
		),
		vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendor.id, {
			onDelete: 'set null'
		}),
		costCenterId: bigint('cost_center_id', { mode: 'number' }).references(() => costCenter.id, {
			onDelete: 'set null'
		}),
		competencyMonth: date('competency_month', { mode: 'string' }),
		notes: text('notes'),
		sourceRecurringExpenseId: bigint('source_recurring_expense_id', { mode: 'number' }).references(
			() => recurringExpense.id,
			{ onDelete: 'set null' }
		),
		importBatchId: bigint('import_batch_id', { mode: 'number' }).references(() => importBatch.id, {
			onDelete: 'set null'
		}),
		installmentGroupId: text('installment_group_id'),
		installmentNumber: integer('installment_number'),
		installmentsTotal: integer('installments_total'),
		status: text('status').notNull().default('posted'),
		reviewStatus: text('review_status').notNull().default('approved'),
		reviewedByUserId: text('reviewed_by_user_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		reviewRejectionReason: text('review_rejection_reason'),
		paymentStatus: text('payment_status').notNull().default('unpaid'),
		paidAt: date('paid_at', { mode: 'string' }),
		reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
		reconciledByUserId: text('reconciled_by_user_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(table) => [
		check('expense_amount_cents_check', sql`${table.amountCents} > 0`),
		check('expense_status_check', sql`${table.status} in ('posted', 'void')`),
		check(
			'expense_review_status_check',
			sql`${table.reviewStatus} in ('pending', 'approved', 'rejected')`
		),
		check(
			'expense_payment_status_check',
			sql`${table.paymentStatus} in ('unpaid', 'paid', 'reconciled')`
		),
		check(
			'expense_paid_at_check',
			sql`(${table.paymentStatus} = 'unpaid' and ${table.paidAt} is null) or (${table.paymentStatus} in ('paid', 'reconciled') and ${table.paidAt} is not null)`
		),
		check(
			'expense_competency_month_check',
			sql`${table.competencyMonth} is null or extract(day from ${table.competencyMonth}) = 1`
		),
		check(
			'expense_installment_numbers_check',
			sql`(${table.installmentNumber} is null and ${table.installmentsTotal} is null) or (${table.installmentNumber} between 1 and ${table.installmentsTotal} and ${table.installmentsTotal} between 2 and 120)`
		),
		index('expense_workspace_date_idx')
			.on(table.workspaceId, table.expenseDate, table.id)
			.where(sql`${table.deletedAt} is null`),
		index('expense_workspace_posted_date_idx')
			.on(table.workspaceId, table.expenseDate, table.id)
			.where(
				sql`${table.deletedAt} is null and ${table.status} = 'posted' and ${table.reviewStatus} = 'approved'`
			),
		index('expense_workspace_category_date_idx')
			.on(table.workspaceId, table.categoryId, table.expenseDate)
			.where(sql`${table.deletedAt} is null`),
		index('expense_workspace_posted_category_date_idx')
			.on(table.workspaceId, table.categoryId, table.expenseDate)
			.where(
				sql`${table.deletedAt} is null and ${table.status} = 'posted' and ${table.reviewStatus} = 'approved'`
			),
		index('expense_workspace_review_status_idx')
			.on(table.workspaceId, table.reviewStatus, table.expenseDate)
			.where(sql`${table.deletedAt} is null`),
		index('expense_workspace_payment_status_idx')
			.on(table.workspaceId, table.paymentStatus, table.expenseDate)
			.where(sql`${table.deletedAt} is null and ${table.reviewStatus} = 'approved'`),
		index('expense_workspace_competency_idx')
			.on(table.workspaceId, table.competencyMonth, table.expenseDate)
			.where(sql`${table.deletedAt} is null`),
		uniqueIndex('expense_recurring_workspace_date_unique_idx')
			.on(table.workspaceId, table.sourceRecurringExpenseId, table.expenseDate)
			.where(sql`${table.sourceRecurringExpenseId} is not null and ${table.deletedAt} is null`),
		index('expense_import_batch_idx').on(table.importBatchId),
		index('expense_installment_group_idx').on(table.workspaceId, table.installmentGroupId),
		index('expense_source_recurring_idx').on(table.sourceRecurringExpenseId),
		index('expense_payment_method_idx').on(table.paymentMethodId),
		index('expense_vendor_idx').on(table.vendorId),
		index('expense_cost_center_idx').on(table.costCenterId),
		index('expense_category_idx').on(table.categoryId),
		index('expense_created_by_idx').on(table.createdByUserId),
		index('expense_reviewed_by_idx').on(table.reviewedByUserId),
		index('expense_reconciled_by_idx').on(table.reconciledByUserId)
	]
);

export const expenseAttachment = pgTable(
	'expense_attachment',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' })
			.notNull()
			.references(() => workspace.id, { onDelete: 'cascade' }),
		expenseId: bigint('expense_id', { mode: 'number' })
			.notNull()
			.references(() => expense.id, { onDelete: 'cascade' }),
		uploadedByUserId: text('uploaded_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		originalName: text('original_name').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		storageKey: text('storage_key').notNull().unique(),
		sha256: text('sha256').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		check('expense_attachment_size_bytes_check', sql`${table.sizeBytes} between 1 and 2097152`),
		index('expense_attachment_workspace_expense_idx').on(table.workspaceId, table.expenseId),
		index('expense_attachment_expense_idx').on(table.expenseId),
		index('expense_attachment_uploaded_by_idx').on(table.uploadedByUserId)
	]
);

export const auditEvent = pgTable(
	'audit_event',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: bigint('workspace_id', { mode: 'number' }).references(() => workspace.id, {
			onDelete: 'set null'
		}),
		actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id'),
		metadata: jsonb('metadata'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('audit_event_workspace_created_idx').on(table.workspaceId, table.createdAt),
		index('audit_event_actor_idx').on(table.actorUserId)
	]
);

export const userMfaConfig = pgTable('user_mfa_config', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	encryptedSecret: text('encrypted_secret').notNull(),
	recoveryCodeHashes: jsonb('recovery_code_hashes').$type<string[]>().notNull().default([]),
	lastUsedTotpCounter: bigint('last_used_totp_counter', { mode: 'number' }),
	enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

export const mfaSession = pgTable(
	'mfa_session',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		sessionId: text('session_id')
			.notNull()
			.references(() => session.id, { onDelete: 'cascade' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('mfa_session_user_session_unique_idx').on(table.userId, table.sessionId),
		index('mfa_session_session_idx').on(table.sessionId),
		index('mfa_session_expires_at_idx').on(table.expiresAt)
	]
);

export const rateLimitBucket = pgTable(
	'rate_limit_bucket',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		key: text('key').notNull().unique(),
		count: integer('count').notNull().default(0),
		resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('rate_limit_bucket_reset_at_idx').on(table.resetAt)]
);

export const workspaceRelations = relations(workspace, ({ many }) => ({
	members: many(workspaceMember),
	categories: many(category),
	categoryRules: many(categoryRule),
	expenses: many(expense),
	budgets: many(categoryBudget),
	recurringExpenses: many(recurringExpense),
	paymentMethods: many(paymentMethod),
	vendors: many(vendor),
	costCenters: many(costCenter)
}));

export const workspaceMemberRelations = relations(workspaceMember, ({ one }) => ({
	workspace: one(workspace, {
		fields: [workspaceMember.workspaceId],
		references: [workspace.id]
	}),
	user: one(user, {
		fields: [workspaceMember.userId],
		references: [user.id]
	})
}));

export const categoryRelations = relations(category, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [category.workspaceId],
		references: [workspace.id]
	}),
	parent: one(category, {
		fields: [category.parentCategoryId],
		references: [category.id],
		relationName: 'category_parent'
	}),
	children: many(category, { relationName: 'category_parent' }),
	expenses: many(expense),
	budgets: many(categoryBudget),
	rules: many(categoryRule),
	recurringExpenses: many(recurringExpense)
}));

export const paymentMethodRelations = relations(paymentMethod, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [paymentMethod.workspaceId],
		references: [workspace.id]
	}),
	expenses: many(expense),
	recurringExpenses: many(recurringExpense)
}));

export const vendorRelations = relations(vendor, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [vendor.workspaceId],
		references: [workspace.id]
	}),
	expenses: many(expense)
}));

export const costCenterRelations = relations(costCenter, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [costCenter.workspaceId],
		references: [workspace.id]
	}),
	expenses: many(expense)
}));

export const categoryBudgetRelations = relations(categoryBudget, ({ one }) => ({
	workspace: one(workspace, {
		fields: [categoryBudget.workspaceId],
		references: [workspace.id]
	}),
	category: one(category, {
		fields: [categoryBudget.categoryId],
		references: [category.id]
	}),
	createdBy: one(user, {
		fields: [categoryBudget.createdByUserId],
		references: [user.id]
	})
}));

export const categoryRuleRelations = relations(categoryRule, ({ one }) => ({
	workspace: one(workspace, {
		fields: [categoryRule.workspaceId],
		references: [workspace.id]
	}),
	category: one(category, {
		fields: [categoryRule.categoryId],
		references: [category.id]
	}),
	createdBy: one(user, {
		fields: [categoryRule.createdByUserId],
		references: [user.id]
	})
}));

export const recurringExpenseRelations = relations(recurringExpense, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [recurringExpense.workspaceId],
		references: [workspace.id]
	}),
	category: one(category, {
		fields: [recurringExpense.categoryId],
		references: [category.id]
	}),
	paymentMethod: one(paymentMethod, {
		fields: [recurringExpense.paymentMethodId],
		references: [paymentMethod.id]
	}),
	createdBy: one(user, {
		fields: [recurringExpense.createdByUserId],
		references: [user.id]
	}),
	expenses: many(expense)
}));

export const expenseRelations = relations(expense, ({ one }) => ({
	workspace: one(workspace, {
		fields: [expense.workspaceId],
		references: [workspace.id]
	}),
	category: one(category, {
		fields: [expense.categoryId],
		references: [category.id]
	}),
	paymentMethod: one(paymentMethod, {
		fields: [expense.paymentMethodId],
		references: [paymentMethod.id]
	}),
	vendor: one(vendor, {
		fields: [expense.vendorId],
		references: [vendor.id]
	}),
	costCenter: one(costCenter, {
		fields: [expense.costCenterId],
		references: [costCenter.id]
	}),
	createdBy: one(user, {
		fields: [expense.createdByUserId],
		references: [user.id]
	}),
	reviewedBy: one(user, {
		fields: [expense.reviewedByUserId],
		references: [user.id]
	}),
	reconciledBy: one(user, {
		fields: [expense.reconciledByUserId],
		references: [user.id]
	}),
	sourceRecurringExpense: one(recurringExpense, {
		fields: [expense.sourceRecurringExpenseId],
		references: [recurringExpense.id]
	}),
	importBatch: one(importBatch, {
		fields: [expense.importBatchId],
		references: [importBatch.id]
	})
}));

export const expenseAttachmentRelations = relations(expenseAttachment, ({ one }) => ({
	workspace: one(workspace, {
		fields: [expenseAttachment.workspaceId],
		references: [workspace.id]
	}),
	expense: one(expense, {
		fields: [expenseAttachment.expenseId],
		references: [expense.id]
	}),
	uploadedBy: one(user, {
		fields: [expenseAttachment.uploadedByUserId],
		references: [user.id]
	})
}));

export const importBatchRelations = relations(importBatch, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [importBatch.workspaceId],
		references: [workspace.id]
	}),
	uploadedBy: one(user, {
		fields: [importBatch.uploadedByUserId],
		references: [user.id]
	}),
	expenses: many(expense)
}));

export * from './auth.schema';
