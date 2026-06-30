export function parseBrlToCents(input: string): number {
	const value = input.trim();
	if (!value) throw new Error('Valor obrigatório.');

	const normalized = value
		.replace(/[^\d,.-]/g, '')
		.replace(/\.(?=\d{3}(,|$))/g, '')
		.replace(',', '.');

	if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
		throw new Error('Valor inválido.');
	}

	const numberValue = Number(normalized);
	if (!Number.isFinite(numberValue) || numberValue <= 0) {
		throw new Error('Valor deve ser maior que zero.');
	}

	return Math.round(numberValue * 100);
}

export function formatCents(cents: number, currency = 'BRL') {
	return new Intl.NumberFormat('pt-BR', {
		style: 'currency',
		currency
	}).format(cents / 100);
}
