import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workspace } from '$lib/server/db/schema';

type WorkspaceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const workspaceCurrencyLockNamespace = 'expense-manager:workspace-currency:v1';

export async function lockWorkspaceCurrency(tx: WorkspaceTransaction, workspaceId: number) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceCurrencyLockNamespace}:${workspaceId}`}, 0))`
	);
	const [current] = await tx
		.select({ currency: workspace.currency })
		.from(workspace)
		.where(eq(workspace.id, workspaceId))
		.limit(1);
	if (!current) throw new Error('Workspace currency lock target not found.');
	return current.currency;
}
