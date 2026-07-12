import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { emailVerificationThrottle, user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	attachmentDeletion,
	budgetAlertDelivery,
	budgetAlertPreference,
	budgetAlertRecipient,
	category,
	categoryBudget,
	categoryRule,
	emailDeliveryEvent,
	expense,
	expenseAttachment,
	importBatch,
	importPreview,
	paymentMethod,
	recurringExpense,
	vendor,
	workspace,
	workspaceInvitation,
	workspaceInvitationDelivery,
	workspaceMember
} from '$lib/server/db/schema';
import { client, db } from '$lib/server/db';
import { sendBudgetAlertEmail } from '$lib/server/email';
import { sha256 } from '$lib/server/utils/crypto';
import { maxMoneyCents } from '$lib/server/utils/money';
import { formatCents } from '$lib/utils/format';
import { getAttachmentForDownload, maxAttachmentBytes, saveExpenseAttachment } from './attachments';
import {
	archiveCategoryRule,
	createCategoryRule,
	getActiveRules,
	listCategoryRules,
	matchCategoryRule,
	matchCategoryRuleFromRules
} from './category-rules';
import { createCategory, listCategories, removeCategory, unarchiveCategory } from './categories';
import {
	deleteBudget,
	getBudgetAlertPreference,
	getBudgetSummary,
	listBudgetAlertDeliveryHistory,
	listBudgetAlertEligibleRecipients,
	listBudgetStatus,
	retryBudgetAlertDelivery,
	runAutomaticBudgetAlertScheduler,
	sendBudgetAlerts,
	setBudgetAlertPreference,
	upsertBudget
} from './budgets';
import { acceptInvitation, getPendingInvitation } from './invitations';
import {
	deliverInvitation,
	invitationDeliveryMaxAttempts,
	invitationDeliverySchedulerLockKey,
	runInvitationDeliveryScheduler
} from './invitation-delivery';
import {
	createExpense,
	bulkReviewExpenses,
	deleteExpense,
	getAnalyticalExpenseReport,
	getDashboard,
	getExpenseListSummary,
	getReport,
	listExpenses,
	reviewExpense,
	updateExpense,
	updateExpensePaymentStatus
} from './expenses';
import { expenseTrashDates, expenseTrashRetentionMs, restoreTrashedExpense } from './expense-trash';
import {
	getOrCreateCatalogItem,
	listExpenseCatalogs,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem
} from './expense-catalogs';
import {
	confirmImportPreview,
	confirmedImportPreviewRetentionMs,
	importExpenses,
	importPreviewTtlMs,
	listImportBatches,
	pruneExpiredImportPreviews,
	previewImportExpenses,
	undoImportBatch
} from './imports';
import {
	parseMailjetWebhookPayload,
	pruneEmailDeliveryEvents,
	recordMailjetDeliveryEvents
} from './email-delivery-events';
import {
	createRecurringExpense,
	materializeDueRecurringExpenses,
	runRecurringExpenseScheduler,
	setRecurringExpenseStatus
} from './recurring';
import {
	pruneExpiredUnverifiedRegistrations,
	requestVerificationEmail
} from './email-verification';
import { inviteMember, resendInvitation, type WorkspaceContext } from './workspaces';

import { registerVerificationTests } from './service-integration/verification.cases';
import { registerImportTests } from './service-integration/imports.cases';
import { registerExpenseTests } from './service-integration/expenses.cases';
import { registerBudgetAlertTests } from './service-integration/budget-alerts.cases';
import { registerInvitationTests } from './service-integration/invitations.cases';
import { registerExpenseLifecycleTests } from './service-integration/expense-lifecycle.cases';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const uploadDirs: string[] = [];

async function createWorkspaceFixture() {
	const owner = await createUser('owner');
	const [workspaceRow] = await db
		.insert(workspace)
		.values({
			name: `Workspace ${randomUUID()}`,
			createdByUserId: owner.id,
			currency: 'USD'
		})
		.returning({
			id: workspace.id,
			name: workspace.name,
			weekStartsOn: workspace.weekStartsOn,
			currency: workspace.currency
		});
	workspaceIds.push(workspaceRow.id);

	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId: owner.id,
		role: 'owner',
		status: 'active'
	});

	const [categoryRow] = await db
		.insert(category)
		.values({
			workspaceId: workspaceRow.id,
			name: 'Limpeza',
			color: '#0f766e',
			icon: '🧼'
		})
		.returning({ id: category.id });

	const context: WorkspaceContext = {
		userId: owner.id,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		weekStartsOn: workspaceRow.weekStartsOn,
		currency: workspaceRow.currency,
		locale: 'en',
		role: 'owner'
	};

	return { context, categoryId: categoryRow.id, owner };
}

async function createMemberContext(
	fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
	role: WorkspaceContext['role']
) {
	const member = await createUser(role);
	await db.insert(workspaceMember).values({
		workspaceId: fixture.context.workspaceId,
		userId: member.id,
		role,
		status: 'active'
	});

	return {
		...fixture.context,
		userId: member.id,
		role
	};
}

async function createExpenseCatalogs(
	context: WorkspaceContext,
	input: { paymentMethod?: string; vendor?: string; costCenter?: string }
) {
	const [paymentMethodItem, vendorItem, costCenterItem] = await Promise.all([
		input.paymentMethod
			? getOrCreateCatalogItem(db, context.workspaceId, 'paymentMethod', input.paymentMethod)
			: Promise.resolve(null),
		input.vendor
			? getOrCreateCatalogItem(db, context.workspaceId, 'vendor', input.vendor)
			: Promise.resolve(null),
		input.costCenter
			? getOrCreateCatalogItem(db, context.workspaceId, 'costCenter', input.costCenter)
			: Promise.resolve(null)
	]);

	return {
		paymentMethodId: paymentMethodItem?.id,
		vendorId: vendorItem?.id,
		costCenterId: costCenterItem?.id
	};
}

async function seedWarningBudget(fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>) {
	await upsertBudget(fixture.context, {
		categoryId: fixture.categoryId,
		periodMonth: '2026-06',
		amount: '100.00',
		warningThresholdPct: 80
	});
	await createExpense(fixture.context, {
		categoryId: fixture.categoryId,
		description: `Budget alert ${randomUUID()}`,
		amount: '90.00',
		expenseDate: '2026-06-15'
	});
}

async function createUser(prefix: string, options: { emailVerified?: boolean } = {}) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({
		id,
		name: prefix,
		email,
		emailVerified: options.emailVerified ?? true
	});
	userIds.push(id);
	return { id, email };
}

async function findUserById(userId: string) {
	const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
	return row ?? null;
}

async function findWorkspaceById(workspaceId: number) {
	const [row] = await db
		.select({ id: workspace.id })
		.from(workspace)
		.where(eq(workspace.id, workspaceId))
		.limit(1);
	return row ?? null;
}

export const serviceIntegrationTestContext = {
	afterEach,
	randomUUID,
	mkdtemp,
	readdir,
	rm,
	tmpdir,
	path,
	expect,
	it,
	vi,
	and,
	eq,
	inArray,
	emailVerificationThrottle,
	user,
	auditEvent,
	attachmentDeletion,
	budgetAlertDelivery,
	budgetAlertPreference,
	budgetAlertRecipient,
	category,
	categoryBudget,
	categoryRule,
	emailDeliveryEvent,
	expense,
	expenseAttachment,
	importBatch,
	importPreview,
	paymentMethod,
	recurringExpense,
	vendor,
	workspace,
	workspaceInvitation,
	workspaceInvitationDelivery,
	workspaceMember,
	client,
	db,
	sendBudgetAlertEmail,
	sha256,
	maxMoneyCents,
	formatCents,
	getAttachmentForDownload,
	maxAttachmentBytes,
	saveExpenseAttachment,
	archiveCategoryRule,
	createCategoryRule,
	getActiveRules,
	listCategoryRules,
	matchCategoryRule,
	matchCategoryRuleFromRules,
	createCategory,
	listCategories,
	removeCategory,
	unarchiveCategory,
	deleteBudget,
	getBudgetAlertPreference,
	getBudgetSummary,
	listBudgetAlertDeliveryHistory,
	listBudgetAlertEligibleRecipients,
	listBudgetStatus,
	retryBudgetAlertDelivery,
	runAutomaticBudgetAlertScheduler,
	sendBudgetAlerts,
	setBudgetAlertPreference,
	upsertBudget,
	acceptInvitation,
	getPendingInvitation,
	deliverInvitation,
	invitationDeliveryMaxAttempts,
	invitationDeliverySchedulerLockKey,
	runInvitationDeliveryScheduler,
	createExpense,
	bulkReviewExpenses,
	deleteExpense,
	getAnalyticalExpenseReport,
	getDashboard,
	getExpenseListSummary,
	getReport,
	listExpenses,
	reviewExpense,
	updateExpense,
	updateExpensePaymentStatus,
	expenseTrashDates,
	expenseTrashRetentionMs,
	restoreTrashedExpense,
	getOrCreateCatalogItem,
	listExpenseCatalogs,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem,
	confirmImportPreview,
	confirmedImportPreviewRetentionMs,
	importExpenses,
	importPreviewTtlMs,
	listImportBatches,
	pruneExpiredImportPreviews,
	previewImportExpenses,
	undoImportBatch,
	parseMailjetWebhookPayload,
	pruneEmailDeliveryEvents,
	recordMailjetDeliveryEvents,
	createRecurringExpense,
	materializeDueRecurringExpenses,
	runRecurringExpenseScheduler,
	setRecurringExpenseStatus,
	pruneExpiredUnverifiedRegistrations,
	requestVerificationEmail,
	inviteMember,
	resendInvitation,
	workspaceIds,
	userIds,
	uploadDirs,
	createWorkspaceFixture,
	createMemberContext,
	createExpenseCatalogs,
	seedWarningBudget,
	createUser,
	findUserById,
	findWorkspaceById
};

export type ServiceIntegrationTestContext = typeof serviceIntegrationTestContext;

describe('server service integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
			await db.delete(attachmentDeletion).where(eq(attachmentDeletion.workspaceId, workspaceId));
		}
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
		for (const uploadDir of uploadDirs.splice(0)) {
			await rm(uploadDir, { recursive: true, force: true });
		}
	});

	registerVerificationTests(serviceIntegrationTestContext);
	registerImportTests(serviceIntegrationTestContext);
	registerExpenseTests(serviceIntegrationTestContext);
	registerBudgetAlertTests(serviceIntegrationTestContext);
	registerInvitationTests(serviceIntegrationTestContext);
	registerExpenseLifecycleTests(serviceIntegrationTestContext);
});
