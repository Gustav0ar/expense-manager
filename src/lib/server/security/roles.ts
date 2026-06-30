export type Role = 'owner' | 'admin' | 'member' | 'viewer';

const rank: Record<Role, number> = {
	viewer: 1,
	member: 2,
	admin: 3,
	owner: 4
};

export function canRead(role: Role) {
	return rank[role] >= rank.viewer;
}

export function canWriteExpenses(role: Role) {
	return rank[role] >= rank.member;
}

export function canReviewExpenses(role: Role) {
	return rank[role] >= rank.admin;
}

export function canReconcileExpenses(role: Role) {
	return rank[role] >= rank.admin;
}

export function canManageCategories(role: Role) {
	return rank[role] >= rank.admin;
}

export function canManageMembers(role: Role) {
	return rank[role] >= rank.admin;
}

export function canManageWorkspace(role: Role) {
	return role === 'owner';
}

export function canManageBudgets(role: Role) {
	return rank[role] >= rank.admin;
}

export function assertRole(role: Role, allowed: (role: Role) => boolean) {
	if (!allowed(role)) {
		throw new Error('Permissao insuficiente.');
	}
}
