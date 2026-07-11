export const importDuplicateLookupChunkSize = 100;
export const importInsertChunkSize = 100;
export const importCatalogUpsertChunkSize = 100;

export type ImportExpenseIdentity = {
	amountCents: number;
	expenseDate: string;
	description: string;
};

export function importExpenseIdentityKey(identity: ImportExpenseIdentity) {
	return JSON.stringify([identity.amountCents, identity.expenseDate, identity.description]);
}

export function uniqueImportExpenseIdentities(rows: ImportExpenseIdentity[]) {
	const unique = new Map<string, ImportExpenseIdentity>();

	for (const row of rows) {
		const key = importExpenseIdentityKey(row);
		if (!unique.has(key)) unique.set(key, row);
	}

	return [...unique.values()];
}

export function classifyImportExpenseRows<Row extends ImportExpenseIdentity>(
	rows: Row[],
	existingRows: ImportExpenseIdentity[]
) {
	const existingKeys = new Set(existingRows.map(importExpenseIdentityKey));
	const acceptedRows = rows.filter((row) => !existingKeys.has(importExpenseIdentityKey(row)));

	return {
		acceptedRows,
		duplicateCount: rows.length - acceptedRows.length
	};
}

export function chunkImportValues<Value>(values: Value[], chunkSize: number) {
	if (!Number.isInteger(chunkSize) || chunkSize < 1) {
		throw new RangeError('Import chunk size must be a positive integer.');
	}

	const chunks: Value[][] = [];
	for (let start = 0; start < values.length; start += chunkSize) {
		chunks.push(values.slice(start, start + chunkSize));
	}
	return chunks;
}
