import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('csv helpers', () => {
	it('escapes quotes and wraps values', () => {
		expect(csvCell('Administrativo "Matriz"')).toBe('"Administrativo ""Matriz"""');
		expect(csvCell(12540)).toBe('"12540"');
	});

	it('neutralizes values that spreadsheet apps can interpret as formulas', () => {
		expect(csvCell('=IMPORTXML("https://example.com")')).toBe(
			`"'=IMPORTXML(""https://example.com"")"`
		);
		expect(csvCell('  -10+20')).toBe(`"'  -10+20"`);
		expect(csvCell('@usuário')).toBe(`"'@usuário"`);
	});
});
