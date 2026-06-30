const formulaStartPattern = /^\s*[=+\-@]/;

export function csvCell(value: string | number) {
	const stringValue = String(value);
	const safeValue = formulaStartPattern.test(stringValue) ? `'${stringValue}` : stringValue;
	return `"${safeValue.replaceAll('"', '""')}"`;
}
