import { describe, expect, it } from 'vitest';
import { paymentClass, paymentLabel, reviewClass, reviewLabel } from './status';

const t = (key: string) => `translated:${key}`;

describe('status presentation utilities', () => {
	it('maps review statuses and keeps unknown values readable', () => {
		expect(reviewLabel('approved', t)).toBe('translated:Approved');
		expect(reviewLabel('rejected', t)).toBe('translated:Rejected');
		expect(reviewLabel('pending', t)).toBe('translated:Pending');
		expect(reviewLabel('custom', t)).toBe('translated:Approved');
		expect(reviewClass('approved')).toBe('status-pill success');
		expect(reviewClass('rejected')).toBe('status-pill danger');
		expect(reviewClass('pending')).toBe('status-pill warning');
		expect(reviewClass('custom')).toBe('status-pill success');
	});

	it('maps payment statuses and keeps unknown values readable', () => {
		expect(paymentLabel('paid', t)).toBe('translated:Paid');
		expect(paymentLabel('reconciled', t)).toBe('translated:Reconciled');
		expect(paymentLabel('unpaid', t)).toBe('translated:Open');
		expect(paymentLabel('custom', t)).toBe('translated:Open');
		expect(paymentClass('paid')).toBe('status-pill info');
		expect(paymentClass('reconciled')).toBe('status-pill success');
		expect(paymentClass('unpaid')).toBe('status-pill neutral');
		expect(paymentClass('custom')).toBe('status-pill neutral');
	});
});
