export const auditActions = [
	['bank_statement.staged', 'Bank statement staged'],
	['bank_transaction.created', 'Bank transaction created'],
	['bank_transaction.ignored', 'Bank transaction ignored'],
	['bank_transaction.matched', 'Bank transaction matched'],
	['bank_transaction.reversed', 'Bank transaction reconciliation reversed'],
	['budget.alert_delivery_retried', 'Budget alert delivery retried'],
	['budget.alerts_disabled', 'Budget alerts disabled'],
	['budget.alerts_enabled', 'Budget alerts enabled'],
	['budget.alerts_sent', 'Budget alerts sent'],
	['budget.deleted', 'Budget deleted'],
	['budget.upserted', 'Budget saved'],
	['category.archived', 'Category archived'],
	['category.created', 'Category created'],
	['category.deleted', 'Category deleted'],
	['category.unarchived', 'Category restored'],
	['category.updated', 'Category updated'],
	['category_rule.archived', 'Category rule archived'],
	['category_rule.created', 'Category rule created'],
	['expense.approved', 'Expense approved'],
	['expense.bulk_approved', 'Expenses approved in bulk'],
	['expense.bulk_rejected', 'Expenses rejected in bulk'],
	['expense.created', 'Expense created'],
	['expense.deleted', 'Expense deleted'],
	['expense.installments_created', 'Expense installments created'],
	['expense.payment_paid', 'Expense marked as paid'],
	['expense.payment_reconciled', 'Expense reconciled'],
	['expense.payment_unpaid', 'Expense marked as unpaid'],
	['expense.purged', 'Expense permanently deleted'],
	['expense.rejected', 'Expense rejected'],
	['expense.restored', 'Expense restored'],
	['expense.updated', 'Expense updated'],
	['expense_attachment.created', 'Attachment uploaded'],
	['expense_attachment.deleted', 'Attachment deleted'],
	['expense_catalog.archived', 'Catalog item archived'],
	['expense_catalog.deleted', 'Catalog item deleted'],
	['expense_catalog.updated', 'Catalog item updated'],
	['expense_catalog.upserted', 'Catalog item saved'],
	['expense_import.completed', 'Expense import completed'],
	['expense_import.failed', 'Expense import failed'],
	['expense_import.undone', 'Expense import undone'],
	['mfa.disabled', 'MFA disabled'],
	['mfa.enabled', 'MFA enabled'],
	['recurring_expense.created', 'Recurring expense created'],
	['recurring_expense.materialized', 'Recurring expenses generated'],
	['recurring_expense.paused', 'Recurring expense paused'],
	['recurring_expense.resumed', 'Recurring expense resumed'],
	['workspace.created', 'Workspace created'],
	['workspace.updated', 'Workspace updated'],
	['workspace_invitation.accepted', 'Workspace invitation accepted'],
	['workspace_invitation.resent', 'Workspace invitation resent'],
	['workspace_member.disabled', 'Workspace member disabled'],
	['workspace_member.invited', 'Workspace member invited'],
	['workspace_member.role_changed', 'Workspace member role changed']
] as const;

export const auditEntityTypes = [
	['bank_statement', 'Bank statement'],
	['bank_transaction', 'Bank transaction'],
	['budget', 'Budget'],
	['budget_alert_delivery', 'Budget alert delivery'],
	['budget_alert_preference', 'Budget alert preference'],
	['category', 'Category'],
	['category_budget', 'Category budget'],
	['category_rule', 'Category rule'],
	['costCenter', 'Cost center'],
	['expense', 'Expense'],
	['expense_attachment', 'Expense attachment'],
	['import_batch', 'Import batch'],
	['paymentMethod', 'Payment method'],
	['recurring_expense', 'Recurring expense'],
	['user', 'User'],
	['vendor', 'Vendor'],
	['workspace', 'Workspace'],
	['workspace_invitation', 'Workspace invitation'],
	['workspace_member', 'Workspace member']
] as const;

export const auditActionValues = auditActions.map(([value]) => value) as [
	(typeof auditActions)[number][0],
	...(typeof auditActions)[number][0][]
];
export const auditEntityTypeValues = auditEntityTypes.map(([value]) => value) as [
	(typeof auditEntityTypes)[number][0],
	...(typeof auditEntityTypes)[number][0][]
];

export type AuditAction = (typeof auditActions)[number][0];
export type AuditEntityType = (typeof auditEntityTypes)[number][0];

const actionLabels = new Map<string, string>(auditActions);
const entityLabels = new Map<string, string>(auditEntityTypes);

export const auditMetadataFields = [
	['alertCount', 'Alerts'],
	['asOf', 'Generated through'],
	['bankTransactionId', 'Bank transaction'],
	['budgetCount', 'Budgets'],
	['categoryId', 'Category'],
	['childCount', 'Child categories'],
	['contentType', 'File type'],
	['count', 'Count'],
	['createdCount', 'Created'],
	['decision', 'Decision'],
	['deliveryModel', 'Delivery model'],
	['duplicateCount', 'Duplicates'],
	['email', 'Email'],
	['escalateOverBudget', 'Escalate over budget'],
	['expenseCount', 'Expenses'],
	['expenseId', 'Expense'],
	['expiredAt', 'Expired at'],
	['failedCount', 'Failures'],
	['ids', 'Expenses'],
	['importedCount', 'Imported'],
	['installments', 'Installments'],
	['locale', 'Language'],
	['matchTarget', 'Match target'],
	['name', 'Name'],
	['paidAt', 'Paid at'],
	['periodMonth', 'Period'],
	['postedDate', 'Posted date'],
	['previewId', 'Import preview'],
	['reason', 'Reason'],
	['recipientCount', 'Recipients'],
	['recipientMode', 'Recipient mode'],
	['reconciliationTransactionId', 'Bank transaction'],
	['recurringCount', 'Recurring expenses'],
	['restoredAttachmentCount', 'Restored attachments'],
	['reviewStatus', 'Review status'],
	['role', 'Role'],
	['rowCount', 'Rows'],
	['ruleCount', 'Rules'],
	['sent', 'Sent'],
	['signedAmountCents', 'Signed amount (cents)'],
	['sizeBytes', 'File size (bytes)'],
	['skippedCount', 'Skipped'],
	['sourceType', 'Source type'],
	['undoneCount', 'Undone']
] as const;

const metadataLabels = new Map<string, string>(auditMetadataFields);
const sensitiveKeyPattern =
	/(authorization|cookie|credential|password|recovery|secret|session|token)/i;
const metadataValueLabels: Record<string, Record<string, string>> = {
	decision: { approved: 'Approved', rejected: 'Rejected' },
	reviewStatus: { approved: 'Approved', pending: 'Pending', rejected: 'Rejected' },
	role: { admin: 'Admin', member: 'Member', owner: 'Owner', viewer: 'Viewer' }
};

export function auditActionLabel(action: string) {
	return actionLabels.get(action) ?? action;
}

export function auditEntityLabel(entityType: string) {
	return entityLabels.get(entityType) ?? entityType;
}

export function auditMetadataValueLabel(key: string, value: string) {
	return metadataValueLabels[key]?.[value] ?? value;
}

export function summarizeAuditMetadata(metadata: unknown) {
	if (!isRecord(metadata)) return [];
	return Object.entries(metadata)
		.filter(([key]) => metadataLabels.has(key) && !sensitiveKeyPattern.test(key))
		.map(([key, value]) => ({
			key,
			label: metadataLabels.get(key)!,
			value: formatAuditMetadataValue(value)
		}));
}

export function redactAuditMetadata(metadata: unknown): unknown {
	if (Array.isArray(metadata)) return metadata.map(redactAuditMetadata);
	if (!isRecord(metadata)) return metadata;

	return Object.fromEntries(
		Object.entries(metadata).map(([key, value]) => [
			key,
			sensitiveKeyPattern.test(key) ? '[redacted]' : redactAuditMetadata(value)
		])
	);
}

function formatAuditMetadataValue(value: unknown): string {
	if (value === null || value === undefined || value === '') return '—';
	if (Array.isArray(value)) return value.map(formatAuditMetadataValue).join(', ');
	if (typeof value === 'object') return JSON.stringify(redactAuditMetadata(value));
	return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
