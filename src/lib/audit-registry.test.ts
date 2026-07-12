import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ptBrMessages } from './i18n/messages';
import {
	auditActions,
	auditEntityTypes,
	auditMetadataFields,
	redactAuditMetadata,
	summarizeAuditMetadata
} from './audit-registry';

describe('audit registry', () => {
	it('covers every statically emitted audit action and every dynamic variant', () => {
		const emitted = new Set<string>();
		for (const path of globSync('src/lib/server/services/*.ts')) {
			if (path.endsWith('.test.ts')) continue;
			const source = readFileSync(path, 'utf8');
			for (const match of source.matchAll(/action:\s*['"]([a-z][a-z_.]+)['"]/g)) {
				if (match[1].includes('.')) emitted.add(match[1]);
			}
		}
		[
			'bank_transaction.created',
			'bank_transaction.ignored',
			'bank_transaction.matched',
			'budget.alerts_disabled',
			'budget.alerts_enabled',
			'category.archived',
			'category.deleted',
			'expense.approved',
			'expense.bulk_approved',
			'expense.bulk_rejected',
			'expense.created',
			'expense.installments_created',
			'expense.payment_paid',
			'expense.payment_reconciled',
			'expense.payment_unpaid',
			'expense.rejected',
			'expense_catalog.archived',
			'expense_catalog.deleted',
			'expense_import.failed',
			'recurring_expense.paused',
			'recurring_expense.resumed'
		].forEach((action) => emitted.add(action));

		expect(new Set(auditActions.map(([action]) => action))).toEqual(emitted);
	});

	it('has unique localized action and entity options', () => {
		for (const options of [auditActions, auditEntityTypes, auditMetadataFields]) {
			expect(new Set(options.map(([value]) => value))).toHaveLength(options.length);
			for (const [, label] of options) expect(ptBrMessages).toHaveProperty(label);
		}
	});

	it('summarizes known fields and recursively redacts technical metadata', () => {
		const metadata = {
			role: 'viewer',
			count: 2,
			accessToken: 'top-secret',
			nested: { password: 'hidden', safe: true }
		};

		expect(summarizeAuditMetadata(metadata)).toEqual([
			{ key: 'role', label: 'Role', value: 'viewer' },
			{ key: 'count', label: 'Count', value: '2' }
		]);
		expect(redactAuditMetadata(metadata)).toEqual({
			role: 'viewer',
			count: 2,
			accessToken: '[redacted]',
			nested: { password: '[redacted]', safe: true }
		});
	});
});
