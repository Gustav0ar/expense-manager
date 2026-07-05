export function reviewLabel(value: string, t: (key: string) => string): string {
	if (value === 'pending') return t('Pending');
	if (value === 'rejected') return t('Rejected');
	return t('Approved');
}

export function reviewClass(value: string): string {
	if (value === 'pending') return 'status-pill warning';
	if (value === 'rejected') return 'status-pill danger';
	return 'status-pill success';
}

export function paymentLabel(value: string, t: (key: string) => string): string {
	if (value === 'paid') return t('Paid');
	if (value === 'reconciled') return t('Reconciled');
	return t('Open');
}

export function paymentClass(value: string): string {
	if (value === 'paid') return 'status-pill info';
	if (value === 'reconciled') return 'status-pill success';
	return 'status-pill neutral';
}
