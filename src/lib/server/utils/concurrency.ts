export async function mapWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>
) {
	if (items.length === 0) return;
	const width = Math.min(Math.max(Math.trunc(concurrency), 1), items.length);
	let nextIndex = 0;

	await Promise.all(
		Array.from({ length: width }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex += 1;
				await worker(items[index], index);
			}
		})
	);
}
