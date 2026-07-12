import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const client = postgres(databaseUrl, { max: 1, prepare: false });
const rollbackSentinel = new Error('rollback usage-count fixture');
let report;

async function main() {
	try {
		await client.begin(async (tx) => {
			const userId = 'usage-count-query-plan-fixture';
			await tx`select pg_advisory_xact_lock(hashtextextended('usage-count-query-plan-fixture', 0))`;
			await tx`
			insert into "user" (id, name, email, email_verified)
			values (
				${userId},
				'Usage-count query plan fixture',
				'usage-count-query-plan-fixture@example.invalid',
				true
			)
		`;
			const [workspace] = await tx`
			insert into workspace (name, created_by_user_id, currency)
			values ('Usage-count query plan fixture', ${userId}, 'USD')
			returning id
		`;
			const workspaceId = workspace.id;

			await seedFixture(tx, workspaceId, userId);

			const categoryBaseline = await explainAndRun(tx, categoryBaselineSql, workspaceId);
			const categoryOptimized = await explainAndRun(tx, categoryOptimizedSql, workspaceId);
			assertSameResults('category', categoryBaseline.rows, categoryOptimized.rows);

			const paymentBaseline = await explainAndRun(tx, paymentMethodBaselineSql, workspaceId);
			const paymentOptimized = await explainAndRun(tx, paymentMethodOptimizedSql, workspaceId);
			assertSameResults('payment method', paymentBaseline.rows, paymentOptimized.rows);

			assertIntermediateReduction('category', categoryBaseline.metrics, categoryOptimized.metrics);
			assertIntermediateReduction(
				'payment method',
				paymentBaseline.metrics,
				paymentOptimized.metrics
			);
			const budgetAlertHistoryIndexes = await explainIndexes(
				tx,
				budgetAlertHistorySql,
				workspaceId
			);
			if (!budgetAlertHistoryIndexes.includes('budget_alert_delivery_workspace_history_idx')) {
				throw new Error(
					`budget-alert history did not use its cursor index: ${budgetAlertHistoryIndexes.join(', ')}`
				);
			}
			const expenseTrashIndexes = await explainIndexes(tx, expenseTrashPageSql, workspaceId);
			if (!expenseTrashIndexes.includes('expense_workspace_trash_idx')) {
				throw new Error(
					`expense-trash pagination did not use its cursor index: ${expenseTrashIndexes.join(', ')}`
				);
			}
			const auditIndexes = await explainIndexes(tx, auditCursorPageSql, workspaceId);
			if (!auditIndexes.includes('audit_event_workspace_id_desc_idx')) {
				throw new Error(
					`audit cursor pagination did not use its workspace/id index: ${auditIndexes.join(', ')}`
				);
			}

			report = {
				fixture: {
					parentCategories: 20,
					children: 80,
					expenses: 5000,
					recurrences: 80,
					budgets: 80,
					rules: 80
				},
				category: { baseline: categoryBaseline.metrics, optimized: categoryOptimized.metrics },
				paymentMethod: { baseline: paymentBaseline.metrics, optimized: paymentOptimized.metrics },
				budgetAlertHistory: { indexes: budgetAlertHistoryIndexes },
				expenseTrash: { indexes: expenseTrashIndexes },
				auditCursor: { indexes: auditIndexes }
			};

			throw rollbackSentinel;
		});
	} catch (error) {
		if (error !== rollbackSentinel) throw error;
	} finally {
		await client.end();
	}

	if (!report) throw new Error('Usage-count query plan report was not created');

	console.log(JSON.stringify(report, null, 2));
	console.log(
		'Usage-count queries eliminate multiplicative intermediates; budget-alert history and expense trash use their cursor indexes.'
	);
}

async function seedFixture(tx, workspaceId, userId) {
	await tx`
		insert into category (workspace_id, name, color)
		select ${workspaceId}, 'Category ' || lpad(series::text, 2, '0'), '#2563eb'
		from generate_series(1, 20) series
	`;
	await tx`
		insert into category (workspace_id, name, color, parent_category_id)
		select ${workspaceId},
			'Child ' || parent.id || '-' || child_series,
			'#2563eb',
			parent.id
		from category parent
		cross join generate_series(1, 4) child_series
		where parent.workspace_id = ${workspaceId} and parent.parent_category_id is null
	`;
	const [paymentMethod] = await tx`
		insert into payment_method (workspace_id, name)
		values (${workspaceId}, 'Fixture card')
		returning id
	`;
	await tx`
		insert into expense (
			workspace_id, category_id, created_by_user_id, description,
			amount_cents, expense_date, payment_method_id, payment_method, deleted_at,
			trash_expires_at
		)
		select ${workspaceId}, parent.id, ${userId},
			'Expense ' || expense_series, 100, date '2026-07-01',
			${paymentMethod.id}, 'Fixture card',
			case when expense_series <= 5 then timestamptz '2026-07-02 00:00:00+00' end,
			case when expense_series <= 5 then timestamptz '2026-07-02 00:00:00+00' end
		from category parent
		cross join generate_series(1, 250) expense_series
		where parent.workspace_id = ${workspaceId} and parent.parent_category_id is null
	`;
	await tx`
		insert into recurring_expense (
			workspace_id, category_id, created_by_user_id, description,
			amount_cents, start_date, next_run_date, payment_method_id, payment_method
		)
		select ${workspaceId}, parent.id, ${userId},
			'Recurrence ' || recurrence_series, 100, date '2026-07-01', date '2026-08-01',
			${paymentMethod.id}, 'Fixture card'
		from category parent
		cross join generate_series(1, 4) recurrence_series
		where parent.workspace_id = ${workspaceId} and parent.parent_category_id is null
	`;
	await tx`
		insert into category_budget (
			workspace_id, category_id, period_month, amount_cents, created_by_user_id
		)
		select ${workspaceId}, parent.id,
			(date '2026-01-01' + (budget_series - 1) * interval '1 month')::date,
			10000, ${userId}
		from category parent
		cross join generate_series(1, 4) budget_series
		where parent.workspace_id = ${workspaceId} and parent.parent_category_id is null
	`;
	await tx`
		insert into category_rule (
			workspace_id, category_id, created_by_user_id, name, pattern
		)
		select ${workspaceId}, parent.id, ${userId},
			'Rule ' || parent.id || '-' || rule_series, 'pattern'
		from category parent
		cross join generate_series(1, 4) rule_series
		where parent.workspace_id = ${workspaceId} and parent.parent_category_id is null
	`;
	await tx`
		insert into budget_alert_delivery (workspace_id, period_month, recipient_email)
		select ${workspaceId},
			(date '1900-01-01' + (series - 1) * interval '1 month')::date,
			'usage-count-query-plan-fixture@example.invalid'
		from generate_series(1, 1000) series
	`;
	await tx`
		insert into workspace (name, created_by_user_id, currency)
		select 'Budget history noise ' || series, ${userId}, 'USD'
		from generate_series(1, 40) series
	`;
	await tx`
		insert into budget_alert_delivery (workspace_id, period_month, recipient_email)
		select noise.id,
			(date '1900-01-01' + (series - 1) * interval '1 month')::date,
			'usage-count-query-plan-fixture@example.invalid'
		from workspace noise
		cross join generate_series(1, 1000) series
		where noise.created_by_user_id = ${userId}
			and noise.name like 'Budget history noise %'
	`;
	await tx`
		insert into audit_event (workspace_id, actor_user_id, action, entity_type)
		select case
			when series % 41 = 0 then ${workspaceId}
			else (
				select noise.id
				from workspace noise
				where noise.created_by_user_id = ${userId}
					and noise.name like 'Budget history noise %'
				order by noise.id
				offset (series % 40)
				limit 1
			)
		end,
		${userId}, 'expense.updated', 'expense'
		from generate_series(1, 41000) series
	`;
	await tx`analyze category`;
	await tx`analyze expense`;
	await tx`analyze recurring_expense`;
	await tx`analyze category_budget`;
	await tx`analyze category_rule`;
	await tx`analyze payment_method`;
	await tx`analyze budget_alert_delivery`;
	await tx`analyze audit_event`;
}

async function explainAndRun(tx, query, workspaceId) {
	const rows = await tx.unsafe(query, [workspaceId]);
	const explainRows = await tx.unsafe(`explain (analyze, buffers, format json) ${query}`, [
		workspaceId
	]);
	const document = Object.values(explainRows[0])[0];
	const explain = typeof document === 'string' ? JSON.parse(document) : document;
	return { rows, metrics: collectPlanMetrics(explain[0]) };
}

function collectPlanMetrics(explain) {
	let maxIntermediateRows = 0;
	let nodeCount = 0;

	visit(explain.Plan);

	return {
		executionTimeMs: explain['Execution Time'],
		sharedHitBlocks: explain.Plan['Shared Hit Blocks'] ?? 0,
		tempReadBlocks: explain.Plan['Temp Read Blocks'] ?? 0,
		tempWrittenBlocks: explain.Plan['Temp Written Blocks'] ?? 0,
		maxIntermediateRows,
		nodeCount
	};

	function visit(node) {
		nodeCount += 1;
		maxIntermediateRows = Math.max(
			maxIntermediateRows,
			(node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1)
		);
		for (const child of node.Plans ?? []) visit(child);
	}
}

async function explainIndexes(tx, query, workspaceId) {
	await tx`set local enable_seqscan = off`;
	const explainRows = await tx.unsafe(`explain (format json) ${query}`, [workspaceId]);
	const document = Object.values(explainRows[0])[0];
	const explain = typeof document === 'string' ? JSON.parse(document) : document;
	const indexes = [];
	visit(explain[0].Plan);
	return indexes;

	function visit(node) {
		if (node['Index Name']) indexes.push(node['Index Name']);
		for (const child of node.Plans ?? []) visit(child);
	}
}

function assertSameResults(label, baseline, optimized) {
	if (JSON.stringify(baseline) !== JSON.stringify(optimized)) {
		throw new Error(`${label} usage results changed after preaggregation`);
	}
}

function assertIntermediateReduction(label, baseline, optimized) {
	if (baseline.maxIntermediateRows < optimized.maxIntermediateRows * 10) {
		throw new Error(
			`${label} plan did not materially reduce intermediates: ` +
				`${baseline.maxIntermediateRows} baseline versus ${optimized.maxIntermediateRows} optimized`
		);
	}
}

const categoryBaselineSql = `
	select c.id,
		c.name,
		c.color,
		c.icon,
		c.is_archived,
		c.created_at,
		count(distinct e.id)::int as expense_count,
		count(distinct re.id)::int as recurring_count,
		count(distinct cb.id)::int as budget_count,
		count(distinct cr.id)::int as rule_count,
		count(distinct child.id)::int as child_count
	from category c
	left join expense e on e.workspace_id = c.workspace_id and e.category_id = c.id
	left join recurring_expense re on re.workspace_id = c.workspace_id and re.category_id = c.id
	left join category_budget cb on cb.workspace_id = c.workspace_id and cb.category_id = c.id
	left join category_rule cr on cr.workspace_id = c.workspace_id and cr.category_id = c.id
	left join category child on child.workspace_id = c.workspace_id and child.parent_category_id = c.id
	where c.workspace_id = $1 and c.is_archived = false
	group by c.id, c.name, c.color, c.icon, c.is_archived, c.created_at
	order by c.is_archived asc, c.name asc
`;

const categoryOptimizedSql = `
	with expense_usage as (
		select category_id, count(*)::int as expense_count
		from expense where workspace_id = $1 group by category_id
	), recurring_usage as (
		select category_id, count(*)::int as recurring_count
		from recurring_expense where workspace_id = $1 group by category_id
	), budget_usage as (
		select category_id, count(*)::int as budget_count
		from category_budget where workspace_id = $1 group by category_id
	), rule_usage as (
		select category_id, count(*)::int as rule_count
		from category_rule where workspace_id = $1 group by category_id
	), child_usage as (
		select parent_category_id, count(*)::int as child_count
		from category
		where workspace_id = $1 and parent_category_id is not null
		group by parent_category_id
	)
	select c.id,
		c.name,
		c.color,
		c.icon,
		c.is_archived,
		c.created_at,
		coalesce(eu.expense_count, 0)::int as expense_count,
		coalesce(ru.recurring_count, 0)::int as recurring_count,
		coalesce(bu.budget_count, 0)::int as budget_count,
		coalesce(cu.rule_count, 0)::int as rule_count,
		coalesce(chu.child_count, 0)::int as child_count
	from category c
	left join expense_usage eu on eu.category_id = c.id
	left join recurring_usage ru on ru.category_id = c.id
	left join budget_usage bu on bu.category_id = c.id
	left join rule_usage cu on cu.category_id = c.id
	left join child_usage chu on chu.parent_category_id = c.id
	where c.workspace_id = $1 and c.is_archived = false
	order by c.is_archived asc, c.name asc
`;

const paymentMethodBaselineSql = `
	select pm.id,
		pm.name,
		pm.is_archived,
		pm.created_at,
		count(distinct e.id)::int as expense_count,
		count(distinct re.id)::int as recurring_count
	from payment_method pm
	left join expense e
		on e.workspace_id = pm.workspace_id
		and e.payment_method_id = pm.id
	left join recurring_expense re
		on re.workspace_id = pm.workspace_id
		and re.payment_method_id = pm.id
	where pm.workspace_id = $1 and pm.is_archived = false
	group by pm.id, pm.name, pm.is_archived, pm.created_at
	order by pm.name asc, pm.id asc
`;

const paymentMethodOptimizedSql = `
	with expense_usage as (
		select payment_method_id, count(*)::int as expense_count
		from expense
		where workspace_id = $1 and payment_method_id is not null
		group by payment_method_id
	), recurring_usage as (
		select payment_method_id, count(*)::int as recurring_count
		from recurring_expense
		where workspace_id = $1 and payment_method_id is not null
		group by payment_method_id
	)
	select pm.id,
		pm.name,
		pm.is_archived,
		pm.created_at,
		coalesce(eu.expense_count, 0)::int as expense_count,
		coalesce(ru.recurring_count, 0)::int as recurring_count
	from payment_method pm
	left join expense_usage eu on eu.payment_method_id = pm.id
	left join recurring_usage ru on ru.payment_method_id = pm.id
	where pm.workspace_id = $1 and pm.is_archived = false
	order by pm.name asc, pm.id asc
`;

const budgetAlertHistorySql = `
	select id, period_month, status, attempt_count, updated_at
	from budget_alert_delivery
	where workspace_id = $1 and id < 9223372036854775807
	order by id desc
	limit 21
`;

const expenseTrashPageSql = `
	select e.id, e.deleted_at, c.name
	from expense e
	join category c on c.id = e.category_id
	where e.workspace_id = $1
		and e.deleted_at is not null
		and (
			e.deleted_at < timestamptz '9999-12-31 23:59:59+00'
			or (
				e.deleted_at = timestamptz '9999-12-31 23:59:59+00'
				and e.id < 9223372036854775807
			)
		)
	order by e.deleted_at desc, e.id desc
	limit 101
`;

const auditCursorPageSql = `
	select id, action, entity_type, created_at
	from audit_event
	where workspace_id = $1 and id < 9223372036854775807
	order by id desc
	limit 101
`;

await main();
