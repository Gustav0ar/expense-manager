import { describe, expect, it } from 'vitest';
import {
	assertRole,
	canManageBudgets,
	canManageCategories,
	canManageMembers,
	canManageWorkspace,
	canRead,
	canReconcileExpenses,
	canReviewExpenses,
	canWriteExpenses
} from './roles';

describe('role permissions', () => {
	it('allows every active role to read', () => {
		expect(canRead('viewer')).toBe(true);
		expect(canRead('member')).toBe(true);
		expect(canRead('admin')).toBe(true);
		expect(canRead('owner')).toBe(true);
	});

	it('limits write and management permissions', () => {
		expect(canWriteExpenses('viewer')).toBe(false);
		expect(canWriteExpenses('member')).toBe(true);
		expect(canReviewExpenses('member')).toBe(false);
		expect(canReviewExpenses('admin')).toBe(true);
		expect(canReconcileExpenses('member')).toBe(false);
		expect(canReconcileExpenses('owner')).toBe(true);
		expect(canManageCategories('member')).toBe(false);
		expect(canManageCategories('admin')).toBe(true);
		expect(canManageBudgets('member')).toBe(false);
		expect(canManageBudgets('admin')).toBe(true);
		expect(canManageMembers('admin')).toBe(true);
		expect(canManageWorkspace('admin')).toBe(false);
		expect(canManageWorkspace('owner')).toBe(true);
	});

	it('throws when a role is not allowed', () => {
		expect(() => assertRole('member', canManageCategories)).toThrow('Permission denied.');
		expect(() => assertRole('owner', canManageCategories)).not.toThrow();
	});
});
