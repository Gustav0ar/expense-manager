import { describe, expect, it } from 'vitest';
import {
	descriptionOverlap,
	normalizeReconciliationText,
	parseOfxForReconciliation
} from './reconciliation';

describe('OFX reconciliation parser', () => {
	it('rejects missing and over-limit transaction collections', () => {
		expect(() => parseOfxForReconciliation('<OFX></OFX>')).toThrow();
		const rows = Array.from(
			{ length: 501 },
			(_, index) => `<STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<FITID>${index}<NAME>Row</STMTTRN>`
		).join('');
		expect(() =>
			parseOfxForReconciliation(`<OFX><BANKTRANLIST>${rows}</BANKTRANLIST></OFX>`)
		).toThrow();
	});

	it('builds stable account-scoped identities from FITID without retaining account data', () => {
		const content = ofx(`
			<STMTTRN><DTPOSTED>20260710120000[-3:BRT]<TRNAMT>-42.35<FITID>bank-123<NAME>Café Central</STMTTRN>
		`);
		const first = parseOfxForReconciliation(content);
		const repeated = parseOfxForReconciliation(content);

		expect(first.sourceAccountFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(first.sourceCurrency).toBe('BRL');
		expect(first.sourceAccountFingerprint).not.toContain('987654');
		expect(first.transactions[0]).toMatchObject({
			providerTransactionId: 'bank-123',
			postedDate: '2026-07-10',
			signedAmountCents: -4235,
			description: 'Café Central'
		});
		expect(first.transactions[0]?.sourceIdentity).toBe(repeated.transactions[0]?.sourceIdentity);
	});

	it('treats opaque provider IDs and punctuated account IDs as collision-sensitive', () => {
		const parsed = parseOfxForReconciliation(
			ofx(`
				<STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<FITID>A-1<NAME>First</STMTTRN>
				<STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<FITID>A 1<NAME>Second</STMTTRN>
			`)
		);
		expect(parsed.transactions[0]?.sourceIdentity).not.toBe(parsed.transactions[1]?.sourceIdentity);
		const otherAccount = parseOfxForReconciliation(
			ofx('<STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<FITID>A-1<NAME>First</STMTTRN>').replace(
				'<ACCTID>987654',
				'<ACCTID>987-654'
			)
		);
		expect(parsed.transactions[0]?.sourceIdentity).not.toBe(
			otherAccount.transactions[0]?.sourceIdentity
		);
	});

	it('uses stable occurrence checksums when FITID is absent and preserves signed credits', () => {
		const content = ofx(`
			<STMTTRN><DTPOSTED>20260711<TRNAMT>-10.00<NAME>Repeated</STMTTRN>
			<STMTTRN><DTPOSTED>20260711<TRNAMT>-10.00<NAME>Repeated</STMTTRN>
			<STMTTRN><DTPOSTED>20260712<TRNAMT>8.50<NAME>Refund</STMTTRN>
		`);
		const first = parseOfxForReconciliation(content);
		const repeated = parseOfxForReconciliation(content);

		expect(new Set(first.transactions.map((row) => row.sourceIdentity)).size).toBe(3);
		expect(first.transactions.map((row) => row.sourceIdentity)).toEqual(
			repeated.transactions.map((row) => row.sourceIdentity)
		);
		expect(first.transactions[2]?.signedAmountCents).toBe(850);
	});

	it('rejects invalid zero/oversized rows while retaining valid rows', () => {
		const parsed = parseOfxForReconciliation(
			ofx(`
				<STMTTRN><DTPOSTED>20260711<TRNAMT>0<NAME>Zero</STMTTRN>
				<STMTTRN><DTPOSTED>20260712<TRNAMT>-7.25<NAME>Valid</STMTTRN>
			`)
		);
		expect(parsed.transactions).toHaveLength(1);
		expect(parsed.errors).toEqual([
			expect.objectContaining({ rowNumber: 1, message: expect.stringContaining('date, amount') })
		]);
	});

	it('handles SGML fallbacks, explicit plus signs and independently invalid fields', () => {
		const content = `<OFX><BANKTRANLIST>
			<STMTTRN><DTPOSTED>20260713<TRNAMT>+3,25<MEMO>Memo only</STMTTRN>
			<STMTTRN><DTPOSTED>bad<TRNAMT>-1.00<NAME>Bad date</STMTTRN>
			<STMTTRN><DTPOSTED>20260714<TRNAMT>-1.001<NAME>Bad amount</STMTTRN>
			<STMTTRN><DTPOSTED>20260714<TRNAMT>-1000000000.01<NAME>Too large</STMTTRN>
			<STMTTRN><DTPOSTED>20260714<TRNAMT>-1.00</STMTTRN>
		</BANKTRANLIST></OFX>`;
		const parsed = parseOfxForReconciliation(content);
		expect(parsed.transactions).toEqual([
			expect.objectContaining({
				description: 'Memo only',
				memo: null,
				providerTransactionId: null,
				signedAmountCents: 325
			})
		]);
		expect(parsed.errors).toHaveLength(4);
	});

	it('rejects malformed currencies while deliberately accepting legacy files without CURDEF', () => {
		expect(() =>
			parseOfxForReconciliation(
				'<OFX><CURDEF>REAL<BANKTRANLIST><STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<NAME>Row</STMTTRN></BANKTRANLIST></OFX>'
			)
		).toThrow();
		const legacy = parseOfxForReconciliation(
			'<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20260710<TRNAMT>-1.00<NAME>Legacy</STMTTRN></BANKTRANLIST></OFX>'
		);
		expect(legacy.sourceCurrency).toBeNull();
	});
});

describe('deterministic reconciliation text ordering', () => {
	it('normalizes independently of locale and scores token overlap', () => {
		expect(normalizeReconciliationText('  CAFÉ—São Paulo! ')).toBe('cafe sao paulo');
		expect(descriptionOverlap('Mercado Central SP', 'Compra mercado central')).toBe(50);
		expect(descriptionOverlap('Unrelated', 'Different')).toBe(0);
	});
});

function ofx(transactions: string) {
	return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001<ACCTID>987654<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${transactions}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}
