import { describe, expect, it } from 'vitest';
import { parseCsvImport, parseExpenseImport, parseOfxImport } from './import';

describe('expense import parser', () => {
	it('parses Portuguese CSV with semicolon delimiter', () => {
		const result = parseCsvImport(
			'Data;Descricao;Valor;Categoria;Pagamento;Fornecedor;Centro de custo\n25/06/2026;Limpeza;R$ 125,40;Limpeza;Pix;Fornecedor A;Operacao\n'
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
				costCenter: 'Operacao',
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
			'Linha 3: data, descrição ou valor inválido.',
			'Linha 4: data, descrição ou valor inválido.'
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

	it('returns explicit errors for empty CSV and invalid OFX transaction rows', () => {
		expect(parseCsvImport('').errors).toEqual(['Arquivo CSV vazio.']);
		expect(parseOfxImport('<STMTTRN><DTPOSTED>bad<TRNAMT>0<NAME>Bad</STMTTRN>').errors).toEqual([
			'Lançamento OFX 1: data ou valor inválido.'
		]);
	});

	it('rejects CSV without required headers', () => {
		const result = parseCsvImport('foo,bar\n1,2\n');

		expect(result.rows).toEqual([]);
		expect(result.errors[0]).toContain('data, descricao e valor');
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
		expect(parseExpenseImport('ofx', 'empty').errors).toEqual([
			'Nenhum lançamento OFX encontrado.'
		]);
	});
});
