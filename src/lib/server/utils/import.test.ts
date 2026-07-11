import { describe, expect, it } from 'vitest';
import { parseCsvImport, parseExpenseImport, parseOfxImport } from './import';

describe('expense import parser', () => {
	it('parses Portuguese CSV with semicolon delimiter', () => {
		const result = parseCsvImport(
			'Data;Descrição;Valor;Categoria;Pagamento;Fornecedor;Centro de custo\n25/06/2026;Limpeza;R$ 125,40;Limpeza;Pix;Fornecedor A;Operação\n'
		);

		expect(result.errors).toEqual([]);
		expect(result.rows).toEqual([
			{
				rowNumber: 2,
				expenseDate: '2026-06-25',
				description: 'Limpeza',
				amount: '125,40',
				categoryName: 'Limpeza',
				paymentMethod: 'Pix',
				vendor: 'Fornecedor A',
				costCenter: 'Operação',
				notes: undefined
			}
		]);
	});

	it('reports malformed CSV rows without rejecting valid rows', () => {
		const result = parseCsvImport(
			'date,description,amount\n2026-06-25,Ok,10.00\nbad,,abc\n2026-02-31,Invalid,20\n'
		);

		expect(result.rows).toHaveLength(1);
		expect(result.errors).toEqual([
			'Line 3: date, description or amount is invalid.',
			'Line 4: date, description or amount is invalid.'
		]);
	});

	it('parses quoted comma CSV, escaped quotes and short US dates', () => {
		const result = parseCsvImport(
			'date,description,amount,notes\r\n1/5/2026,"Produto, ""premium""",-12.30,"linha final"\r\n'
		);

		expect(result.errors).toEqual([]);
		expect(result.rows[0]).toMatchObject({
			expenseDate: '2026-01-05',
			description: 'Produto, "premium"',
			amount: '12,30',
			notes: 'linha final'
		});
	});

	it('rejects explicit positive credits instead of converting them to expenses', () => {
		const csvResult = parseCsvImport(
			'date,description,amount\n2026-01-05,Crédito,+12.30\n2026-01-06,Despesa,12.30\n'
		);
		expect(csvResult.rows).toEqual([
			expect.objectContaining({
				description: 'Despesa',
				amount: '12,30'
			})
		]);
		expect(csvResult.errors).toEqual(['Line 2: date, description or amount is invalid.']);

		const ofxResult = parseOfxImport(`
			<OFX><BANKTRANLIST>
				<STMTTRN><DTPOSTED>20260625120000[-3:BRT]<TRNAMT>42.35<NAME>Estorno</STMTTRN>
				<STMTTRN><DTPOSTED>20260626120000[-3:BRT]<TRNAMT>-21.10<NAME>Despesa</STMTTRN>
			</BANKTRANLIST></OFX>
		`);
		expect(ofxResult.rows).toEqual([
			expect.objectContaining({
				description: 'Despesa',
				amount: '21,10'
			})
		]);
		expect(ofxResult.errors).toEqual(['OFX transaction 1: date or amount is invalid.']);
	});

	it('rejects malformed signs while accepting one leading negative sign', () => {
		const result = parseCsvImport(
			'date,description,amount\n2026-01-05,Embedded sign,1-2\n2026-01-06,Double sign,--1\n2026-01-07,Valid negative,-12.30\n'
		);

		expect(result.rows).toEqual([
			expect.objectContaining({ description: 'Valid negative', amount: '12,30' })
		]);
		expect(result.errors).toEqual([
			'Line 2: date, description or amount is invalid.',
			'Line 3: date, description or amount is invalid.'
		]);
	});

	it('returns explicit errors for empty CSV and invalid OFX transaction rows', () => {
		expect(parseCsvImport('').errors).toEqual(['CSV file is empty.']);
		expect(parseOfxImport('<STMTTRN><DTPOSTED>bad<TRNAMT>0<NAME>Bad</STMTTRN>').errors).toEqual([
			'OFX transaction 1: date or amount is invalid.'
		]);
	});

	it('translates parser errors when a locale is provided', () => {
		expect(parseCsvImport('', 'pt-BR').errors).toEqual(['Arquivo CSV vazio.']);
		expect(parseCsvImport('date,description,amount\nbad,,abc\n', 'pt-BR').errors).toEqual([
			'Linha 2: data, descrição ou valor inválido.'
		]);
	});

	it('accepts the money maximum and rejects larger imported amounts in each locale', () => {
		const english = parseCsvImport(
			'date,description,amount\n2026-01-01,Maximum,"1,000,000,000.00"\n2026-01-02,Too large,1000000000.01\n'
		);
		expect(english.rows).toEqual([
			expect.objectContaining({ description: 'Maximum', amount: '1000000000,00' })
		]);
		expect(english.errors).toEqual(['Line 3: date, description or amount is invalid.']);

		const portuguese = parseCsvImport(
			'Data;Descrição;Valor\n01/01/2026;Máximo;1.000.000.000,00\n02/01/2026;Acima;1.000.000.000,01\n',
			'pt-BR'
		);
		expect(portuguese.rows).toEqual([
			expect.objectContaining({ description: 'Máximo', amount: '1000000000,00' })
		]);
		expect(portuguese.errors).toEqual(['Linha 3: data, descrição ou valor inválido.']);
	});

	it('rejects CSV without required headers', () => {
		const result = parseCsvImport('foo,bar\n1,2\n');

		expect(result.rows).toEqual([]);
		expect(result.errors[0]).toContain('date, description and amount');
	});

	it('parses OFX statement transactions', () => {
		const result = parseOfxImport(`
			<OFX><BANKTRANLIST>
				<STMTTRN><DTPOSTED>20260625120000[-3:BRT]<TRNAMT>-42.35<NAME>Insumos<MEMO>Compra A</STMTTRN>
			</BANKTRANLIST></OFX>
		`);

		expect(result.errors).toEqual([]);
		expect(result.rows[0]).toMatchObject({
			rowNumber: 1,
			expenseDate: '2026-06-25',
			description: 'Insumos',
			amount: '42,35',
			paymentMethod: 'OFX',
			notes: 'Compra A'
		});
	});

	it('dispatches by source type', () => {
		expect(
			parseExpenseImport('csv', 'date,description,amount\n2026-01-01,A,1\n').rows
		).toHaveLength(1);
		expect(parseExpenseImport('ofx', 'empty').errors).toEqual(['No OFX transaction found.']);
	});
});
