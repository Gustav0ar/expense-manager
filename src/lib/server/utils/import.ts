import { defaultLocale, translate } from '$lib/i18n';
import { parseCurrencyToCents } from '$lib/server/utils/money';

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

export const maxExpenseImportRows = 500;
export const maxExpenseImportBytes = 1 * 1024 * 1024;
export const portableExpenseCsvMarker = '# expense-manager-expenses:v1';
export const portableExpenseCsvHeader = [
	'date',
	'description',
	'amount',
	'category',
	'payment_method',
	'vendor',
	'cost_center',
	'notes'
] as const;

export type PortableExpenseCsvRow = {
	expenseDate: string;
	description: string;
	amountCents: number;
	categoryName: string;
	paymentMethod?: string | null;
	vendor?: string | null;
	costCenter?: string | null;
	notes?: string | null;
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
	content: string,
	locale = defaultLocale
): ExpenseImportParseResult {
	if (sourceType === 'csv') return parseCsvImport(content, locale);
	return parseOfxImport(content, locale);
}

export function parseCsvImport(content: string, locale = defaultLocale): ExpenseImportParseResult {
	const rows = parseCsvRows(content);
	const errors: string[] = [];
	if (rows.length === 0) return { rows: [], errors: [translate(locale, 'CSV file is empty.')] };
	const marker = rows[0]?.[0]?.replace(/^\uFEFF/, '').trim();
	const portable = marker === portableExpenseCsvMarker && rows[0]?.length === 1;
	if (marker?.startsWith('# expense-manager-expenses:') && !portable) {
		return {
			rows: [],
			errors: [translate(locale, 'Portable CSV version is not supported.')]
		};
	}
	const headerRowIndex = portable ? 1 : 0;
	if (!rows[headerRowIndex]) {
		return {
			rows: [],
			errors: [translate(locale, 'CSV must contain date, description and amount columns.')]
		};
	}

	const headers = rows[headerRowIndex].map((header) => normalizeHeader(header));
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
			errors: [translate(locale, 'CSV must contain date, description and amount columns.')]
		};
	}

	const importedRows: ImportedExpenseRow[] = [];
	for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (row.every((value) => !value.trim())) continue;

		const rowNumber = index + 1;
		const expenseDate = normalizeDate(row[indexes.date]);
		const description = importValueAt(row, indexes.description, portable) ?? '';
		const amount = normalizeAmount(row[indexes.amount]);

		if (!expenseDate || !description || !amount) {
			errors.push(
				translate(locale, 'Line {rowNumber}: date, description or amount is invalid.', {
					rowNumber
				})
			);
			continue;
		}

		importedRows.push({
			rowNumber,
			expenseDate,
			description,
			amount,
			categoryName: importValueAt(row, indexes.category, portable),
			paymentMethod: importValueAt(row, indexes.paymentMethod, portable),
			vendor: importValueAt(row, indexes.vendor, portable),
			costCenter: importValueAt(row, indexes.costCenter, portable),
			notes: importValueAt(row, indexes.notes, portable)
		});
	}

	return { rows: importedRows, errors };
}

export function serializePortableExpenseCsv(rows: PortableExpenseCsvRow[]) {
	const header = portableExpenseCsvHeader.join(',');
	const body = rows
		.map((row) =>
			[
				portableCsvCell(row.expenseDate),
				portableCsvCell(row.description),
				formatPortableAmount(row.amountCents),
				portableCsvCell(row.categoryName),
				portableCsvCell(row.paymentMethod ?? ''),
				portableCsvCell(row.vendor ?? ''),
				portableCsvCell(row.costCenter ?? ''),
				portableCsvCell(row.notes ?? '')
			].join(',')
		)
		.join('\n');
	return `${portableExpenseCsvMarker}\n${header}\n${body}${body ? '\n' : ''}`;
}

export function parseOfxImport(content: string, locale = defaultLocale): ExpenseImportParseResult {
	const transactions = [
		...content.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi)
	];
	const errors: string[] = [];
	const rows: ImportedExpenseRow[] = [];

	if (transactions.length === 0)
		return { rows: [], errors: [translate(locale, 'No OFX transaction found.')] };

	for (const [index, match] of transactions.entries()) {
		const block = match[1];
		const rowNumber = index + 1;
		const expenseDate = normalizeDate(readOfxTag(block, 'DTPOSTED') ?? '');
		const description =
			readOfxTag(block, 'NAME')?.trim() ||
			readOfxTag(block, 'MEMO')?.trim() ||
			translate(locale, 'OFX transaction');
		const amount = normalizeAmount(readOfxTag(block, 'TRNAMT') ?? '', {
			positiveMeansCredit: true
		});
		const memo = readOfxTag(block, 'MEMO')?.trim();

		if (!expenseDate || !amount) {
			errors.push(
				translate(locale, 'OFX transaction {rowNumber}: date or amount is invalid.', {
					rowNumber
				})
			);
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
		.replace(/^\uFEFF/, '')
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

function normalizeAmount(input: string, options: { positiveMeansCredit?: boolean } = {}) {
	const value = input.trim();
	if (!value) return null;
	const signedValue = value.replace(/[^\d,.\-+]/g, '');
	if (signedValue.startsWith('+')) return null;
	const isNegative = signedValue.startsWith('-');
	if (options.positiveMeansCredit && !isNegative) return null;
	const unsignedValue = isNegative ? signedValue.slice(1) : signedValue;
	if (/[+-]/.test(unsignedValue)) return null;

	try {
		const cents = parseCurrencyToCents(unsignedValue);
		return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
	} catch {
		return null;
	}
}

function readOfxTag(block: string, tag: string) {
	const match = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i'));
	return match?.[1]?.trim() ?? null;
}

function importValueAt(row: string[], index: number, portable: boolean) {
	if (index < 0) return undefined;
	const rawValue = row[index] ?? '';
	const value = (portable ? unprotectPortableCsvValue(rawValue) : rawValue).trim();
	return value || undefined;
}

function formatPortableAmount(amountCents: number) {
	const whole = Math.floor(amountCents / 100);
	const fraction = String(amountCents % 100).padStart(2, '0');
	return `${whole}.${fraction}`;
}

function portableCsvCell(value: string) {
	const protectedValue = /^\s*'*[=+\-@]/.test(value) ? value.replace(/^(\s*)/, "$1'") : value;
	return `"${protectedValue.replaceAll('"', '""')}"`;
}

function unprotectPortableCsvValue(value: string) {
	return value.replace(/^(\s*)'(?='*[=+\-@])/, '$1');
}
