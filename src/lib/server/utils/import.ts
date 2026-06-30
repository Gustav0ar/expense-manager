export type ExpenseImportSource = 'csv' | 'ofx';

export type ImportedExpenseRow = {
	rowNumber: number;
	expenseDate: string;
	description: string;
	amount: string;
	categoryName?: string;
	paymentMethod?: string;
	vendor?: string;
	costCenter?: string;
	notes?: string;
};

export type ExpenseImportParseResult = {
	rows: ImportedExpenseRow[];
	errors: string[];
};

const headerAliases = {
	date: ['date', 'data', 'expense_date', 'dtposted', 'dia'],
	description: ['description', 'descricao', 'descrição', 'name', 'memo', 'historico', 'histórico'],
	amount: ['amount', 'valor', 'value', 'trnamt'],
	category: ['category', 'categoria'],
	paymentMethod: ['payment', 'pagamento', 'payment_method', 'metodo', 'método'],
	vendor: ['vendor', 'fornecedor', 'empresa', 'supplier'],
	costCenter: ['cost_center', 'centro_custo', 'centro_de_custo', 'projeto', 'project'],
	notes: ['notes', 'nota', 'notas', 'memo']
} as const;

export function parseExpenseImport(
	sourceType: ExpenseImportSource,
	content: string
): ExpenseImportParseResult {
	if (sourceType === 'csv') return parseCsvImport(content);
	return parseOfxImport(content);
}

export function parseCsvImport(content: string): ExpenseImportParseResult {
	const rows = parseCsvRows(content);
	const errors: string[] = [];
	if (rows.length === 0) return { rows: [], errors: ['Arquivo CSV vazio.'] };

	const headers = rows[0].map((header) => normalizeHeader(header));
	const indexes = {
		date: findHeader(headers, headerAliases.date),
		description: findHeader(headers, headerAliases.description),
		amount: findHeader(headers, headerAliases.amount),
		category: findHeader(headers, headerAliases.category),
		paymentMethod: findHeader(headers, headerAliases.paymentMethod),
		vendor: findHeader(headers, headerAliases.vendor),
		costCenter: findHeader(headers, headerAliases.costCenter),
		notes: findHeader(headers, headerAliases.notes)
	};

	if (indexes.date === -1 || indexes.description === -1 || indexes.amount === -1) {
		return {
			rows: [],
			errors: ['CSV precisa conter colunas de data, descricao e valor.']
		};
	}

	const importedRows: ImportedExpenseRow[] = [];
	for (let index = 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (row.every((value) => !value.trim())) continue;

		const rowNumber = index + 1;
		const expenseDate = normalizeDate(row[indexes.date]);
		const description = row[indexes.description]?.trim() ?? '';
		const amount = normalizeAmount(row[indexes.amount]);

		if (!expenseDate || !description || !amount) {
			errors.push(`Linha ${rowNumber}: data, descrição ou valor inválido.`);
			continue;
		}

		importedRows.push({
			rowNumber,
			expenseDate,
			description,
			amount,
			categoryName: valueAt(row, indexes.category),
			paymentMethod: valueAt(row, indexes.paymentMethod),
			vendor: valueAt(row, indexes.vendor),
			costCenter: valueAt(row, indexes.costCenter),
			notes: valueAt(row, indexes.notes)
		});
	}

	return { rows: importedRows, errors };
}

export function parseOfxImport(content: string): ExpenseImportParseResult {
	const transactions = [
		...content.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi)
	];
	const errors: string[] = [];
	const rows: ImportedExpenseRow[] = [];

	if (transactions.length === 0) return { rows: [], errors: ['Nenhum lançamento OFX encontrado.'] };

	for (const [index, match] of transactions.entries()) {
		const block = match[1];
		const rowNumber = index + 1;
		const expenseDate = normalizeDate(readOfxTag(block, 'DTPOSTED') ?? '');
		const description =
			readOfxTag(block, 'NAME')?.trim() || readOfxTag(block, 'MEMO')?.trim() || 'Lançamento OFX';
		const amount = normalizeAmount(readOfxTag(block, 'TRNAMT') ?? '');
		const memo = readOfxTag(block, 'MEMO')?.trim();

		if (!expenseDate || !amount) {
			errors.push(`Lançamento OFX ${rowNumber}: data ou valor inválido.`);
			continue;
		}

		rows.push({
			rowNumber,
			expenseDate,
			description,
			amount,
			paymentMethod: 'OFX',
			notes: memo && memo !== description ? memo : undefined
		});
	}

	return { rows, errors };
}

function parseCsvRows(content: string) {
	const delimiter = detectDelimiter(content);
	const rows: string[][] = [];
	let current = '';
	let row: string[] = [];
	let quoted = false;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];

		if (char === '"' && quoted && next === '"') {
			current += '"';
			index += 1;
			continue;
		}

		if (char === '"') {
			quoted = !quoted;
			continue;
		}

		if (!quoted && char === delimiter) {
			row.push(current);
			current = '';
			continue;
		}

		if (!quoted && (char === '\n' || char === '\r')) {
			if (char === '\r' && next === '\n') index += 1;
			row.push(current);
			rows.push(row);
			row = [];
			current = '';
			continue;
		}

		current += char;
	}

	row.push(current);
	if (row.some((value) => value.trim())) rows.push(row);

	return rows;
}

function detectDelimiter(content: string) {
	const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
	const semicolons = (firstLine.match(/;/g) ?? []).length;
	const commas = (firstLine.match(/,/g) ?? []).length;
	return semicolons > commas ? ';' : ',';
}

function findHeader(headers: string[], aliases: readonly string[]) {
	return headers.findIndex((header) => aliases.includes(header));
}

function normalizeHeader(input: string) {
	return input
		.trim()
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.replace(/\s+/g, '_');
}

function normalizeDate(input: string) {
	const value = input.trim();
	const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
	if (compact) return validIsoOrNull(`${compact[1]}-${compact[2]}-${compact[3]}`);

	const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (iso) return validIsoOrNull(value);

	const brazilian = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
	if (brazilian) return validIsoOrNull(`${brazilian[3]}-${brazilian[2]}-${brazilian[1]}`);

	const american = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (american) {
		return validIsoOrNull(
			`${american[3]}-${american[1].padStart(2, '0')}-${american[2].padStart(2, '0')}`
		);
	}

	return null;
}

function validIsoOrNull(value: string) {
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
		? value
		: null;
}

function normalizeAmount(input: string) {
	const value = input.trim();
	if (!value) return null;
	const numeric = value
		.replace(/[^\d,.-]/g, '')
		.replace(/\.(?=\d{3}(,|$))/g, '')
		.replace(',', '.');
	const parsed = Number(numeric);
	if (!Number.isFinite(parsed) || parsed === 0) return null;
	return Math.abs(parsed).toFixed(2).replace('.', ',');
}

function readOfxTag(block: string, tag: string) {
	const match = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i'));
	return match?.[1]?.trim() ?? null;
}

function valueAt(row: string[], index: number) {
	if (index < 0) return undefined;
	const value = row[index]?.trim();
	return value || undefined;
}
