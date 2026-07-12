<script lang="ts">
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { translate } from '$lib/i18n';
	import { resolve } from '$app/paths';
	import { Bell, ChevronRight, History, RotateCcw, Users } from '@lucide/svelte';
	import { untrack } from 'svelte';

	type BudgetItem = {
		categoryId: number;
		categoryName: string;
		categoryColor: string;
		categoryIcon: string | null;
		amountCents: number | null;
		usagePct: number | null;
		warningThresholdPct: number;
		status: 'unset' | 'ok' | 'warning' | 'over';
	};

	type BudgetAlertPreference = {
		isEnabled: boolean;
		recipientMode: 'all_managers' | 'selected';
		escalateOverBudget: boolean;
		recipientUserIds: string[];
	};

	type EligibleRecipient = {
		userId: string;
		name: string;
		email: string;
		isSelected: boolean;
	};

	type DeliveryHistoryItem = {
		id: number;
		periodMonth: string;
		categoryName: string;
		recipientLabel: string;
		level: string | null;
		stage: string | null;
		status: string;
		attemptCount: number;
		sentAt: Date | string | null;
		updatedAt: Date | string;
		lastProviderEvent: string | null;
		lastProviderEventAt: Date | string | null;
		lastErrorCategory: string | null;
		retryable: boolean;
	};

	type Props = {
		locale: string;
		periodMonth: string;
		canManage: boolean;
		budgets: BudgetItem[];
		preference: BudgetAlertPreference;
		eligibleRecipients: EligibleRecipient[];
		history: {
			items: DeliveryHistoryItem[];
			nextCursor: string | null;
		};
	};

	let { locale, periodMonth, canManage, budgets, preference, eligibleRecipients, history }: Props =
		$props();

	let enabled = $state(untrack(() => preference.isEnabled));
	let recipientMode = $state<'all_managers' | 'selected'>(untrack(() => preference.recipientMode));
	let escalateOverBudget = $state(untrack(() => preference.escalateOverBudget));
	let selectedRecipientIds = $state<string[]>(untrack(() => [...preference.recipientUserIds]));

	const budgetedItems = $derived(budgets.filter((budget) => budget.amountCents != null));
	const selectedRecipientValue = $derived(selectedRecipientIds.join(','));
	const selectedRecipientCount = $derived(selectedRecipientIds.length);

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(locale, key, params);
	}

	function toggleRecipient(userId: string, checked: boolean) {
		selectedRecipientIds = checked
			? Array.from(new Set([...selectedRecipientIds, userId]))
			: selectedRecipientIds.filter((selectedId) => selectedId !== userId);
	}

	function isRecipientSelected(userId: string) {
		return selectedRecipientIds.includes(userId);
	}

	function percentage(value: number) {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			maximumFractionDigits: 0
		}).format(value / 100);
	}

	function monthLabel(value: string) {
		const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
		return new Intl.DateTimeFormat(locale, {
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(date);
	}

	function thresholdStatusLabel(status: BudgetItem['status']) {
		if (status === 'over') return t('Over budget');
		if (status === 'warning') return t('Warning threshold reached');
		return t('Below warning threshold');
	}

	function statusLabel(status: string) {
		if (status === 'pending') return t('Pending');
		if (status === 'sending') return t('Sending');
		if (status === 'sent') return t('Sent');
		if (status === 'failed') return t('Failed');
		return t('Unknown status');
	}

	function statusTone(status: string) {
		if (status === 'sent') return 'success';
		if (status === 'failed') return 'danger';
		if (status === 'sending') return 'info';
		return 'neutral';
	}

	function levelLabel(level: string | null) {
		if (level === 'over') return t('Over budget');
		if (level === 'warning') return t('Warning');
		return t('Legacy monthly alert');
	}

	function stageLabel(stage: string | null) {
		if (stage === 'escalation') return t('Escalation');
		if (stage === 'initial') return t('Initial alert');
		return t('Monthly alert');
	}

	function providerEventLabel(event: string | null) {
		if (event === 'open') return t('Open reported by provider');
		if (event === 'click') return t('Click reported by provider');
		if (event === 'sent') return t('Sent reported by provider');
		if (event === 'bounce') return t('Bounce reported by provider');
		if (event === 'blocked') return t('Blocked by provider');
		if (event === 'spam') return t('Spam report received by provider');
		if (event === 'unsub') return t('Unsubscribe reported by provider');
		return t('Provider delivery update');
	}

	function errorLabel(category: string | null) {
		if (category === 'timeout') return t('Delivery timed out');
		if (category === 'configuration') return t('Delivery configuration failed');
		if (category === 'provider_rejected') return t('Delivery was rejected');
		if (category === 'provider_unavailable') return t('Email provider was unavailable');
		if (category === 'network') return t('A network error interrupted delivery');
		return t('Delivery failed');
	}

	function nextPagePath(cursor: string): `/app/planning?${string}` {
		const params = new URLSearchParams({ section: 'budgets', periodMonth, alertCursor: cursor });
		return `/app/planning?${params.toString()}`;
	}
</script>

<section class="notification-center" aria-labelledby="budget-alerts-title">
	<div class="notification-heading">
		<div>
			<span class="eyebrow">{t('Notifications')}</span>
			<h3 id="budget-alerts-title">{t('Budget alerts')}</h3>
			<p>{t('Follow each category from its warning threshold through the monthly limit.')}</p>
		</div>
		<span class={['status-pill', preference.isEnabled ? 'success' : 'neutral']}>
			{preference.isEnabled ? t('Automatic alerts on') : t('Automatic alerts off')}
		</span>
	</div>

	<section class="threshold-section" aria-labelledby="thresholds-title">
		<div class="subheading">
			<div>
				<h4 id="thresholds-title">{t('Alert thresholds')}</h4>
				<p>{t('Current usage for {period}', { period: monthLabel(periodMonth) })}</p>
			</div>
			<span class="subheading-icon" aria-hidden="true"><Bell size={18} /></span>
		</div>

		{#if budgetedItems.length === 0}
			<div class="empty-state compact-empty">
				<strong>{t('No budget thresholds are configured.')}</strong>
				<p>{t('Add a category budget to see its alert threshold here.')}</p>
			</div>
		{:else}
			<div class="threshold-list">
				{#each budgetedItems as budget (budget.categoryId)}
					<article class="threshold-item">
						<div class="threshold-heading">
							<span class="category-label">
								<span aria-hidden="true">{budget.categoryIcon ?? '💼'}</span>
								<strong>{budget.categoryName}</strong>
							</span>
							<span class={['status-pill', budget.status === 'over' ? 'danger' : budget.status]}>
								{thresholdStatusLabel(budget.status)}
							</span>
						</div>
						<div
							class="threshold-rail"
							role="img"
							aria-label={t('{category}: {usage} used; warning at {threshold}.', {
								category: budget.categoryName,
								usage: percentage(budget.usagePct ?? 0),
								threshold: percentage(budget.warningThresholdPct)
							})}
						>
							<span
								class={['usage-fill', budget.status === 'over' ? 'danger' : budget.status]}
								style:--usage={`${Math.min(Math.max(budget.usagePct ?? 0, 0), 100)}%`}
							></span>
							<span class="threshold-marker" style:--threshold={`${budget.warningThresholdPct}%`}
							></span>
						</div>
						<div class="rail-labels" aria-hidden="true">
							<span>{percentage(0)}</span>
							<span style:--threshold={`${budget.warningThresholdPct}%`}>
								{t('Warn at {threshold}', {
									threshold: percentage(budget.warningThresholdPct)
								})}
							</span>
							<span>{percentage(100)}</span>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if canManage}
		<div class="manager-grid">
			<form method="post" action="?/setBudgetAlertPreference" class="preference-card">
				<div class="subheading">
					<div>
						<h4>{t('Notification settings')}</h4>
						<p>{t('Choose who receives threshold and over-budget email alerts.')}</p>
					</div>
					<span class="subheading-icon" aria-hidden="true"><Users size={18} /></span>
				</div>

				<input type="hidden" name="enabled" value="false" />
				<label class="switch-row">
					<span>
						<strong>{t('Automatic email alerts')}</strong>
						<small>{t('Send alerts when configured budget thresholds are reached.')}</small>
					</span>
					<input type="checkbox" name="enabled" value="true" bind:checked={enabled} />
				</label>

				<fieldset>
					<legend>{t('Recipients')}</legend>
					<label class="choice-row">
						<input
							type="radio"
							name="recipientMode"
							value="all_managers"
							bind:group={recipientMode}
						/>
						<span>
							<strong>{t('All workspace managers')}</strong>
							<small>{t('Keep the recipient list aligned with manager access.')}</small>
						</span>
					</label>
					<label class="choice-row">
						<input type="radio" name="recipientMode" value="selected" bind:group={recipientMode} />
						<span>
							<strong>{t('Selected managers')}</strong>
							<small>{t('Send alerts only to the people selected below.')}</small>
						</span>
					</label>
				</fieldset>

				<input type="hidden" name="recipientUserIds" value={selectedRecipientValue} />
				{#if recipientMode === 'selected'}
					<fieldset class="recipient-fieldset">
						<legend>
							{t('Selected recipients ({count})', { count: selectedRecipientCount })}
						</legend>
						{#if eligibleRecipients.length === 0}
							<p class="notice warning" role="status">
								{t('No eligible managers are available for budget alerts.')}
							</p>
						{:else}
							<div class="recipient-list">
								{#each eligibleRecipients as recipient (recipient.userId)}
									<label class="recipient-row">
										<input
											type="checkbox"
											checked={isRecipientSelected(recipient.userId)}
											onchange={(event) =>
												toggleRecipient(recipient.userId, event.currentTarget.checked)}
										/>
										<span>
											<strong>{recipient.name}</strong>
											<small>{recipient.email}</small>
										</span>
									</label>
								{/each}
							</div>
						{/if}
					</fieldset>
				{/if}

				<input type="hidden" name="escalateOverBudget" value="false" />
				<label class="switch-row">
					<span>
						<strong>{t('Escalate when a budget is exceeded')}</strong>
						<small>{t('Send a follow-up alert after a category crosses its monthly limit.')}</small>
					</span>
					<input
						type="checkbox"
						name="escalateOverBudget"
						value="true"
						bind:checked={escalateOverBudget}
					/>
				</label>

				<div class="form-actions">
					<button
						class="button primary"
						type="submit"
						disabled={enabled && recipientMode === 'selected' && selectedRecipientCount === 0}
					>
						{t('Save notification settings')}
					</button>
				</div>
			</form>

			<section class="history-card" aria-labelledby="delivery-history-title">
				<div class="subheading">
					<div>
						<h4 id="delivery-history-title">{t('Delivery history')}</h4>
						<p>{t('Recent budget alert activity and provider updates.')}</p>
					</div>
					<span class="subheading-icon" aria-hidden="true"><History size={18} /></span>
				</div>

				{#if history.items.length === 0}
					<div class="empty-state compact-empty">
						<strong>{t('No alert delivery history yet.')}</strong>
						<p>{t('Delivery attempts will appear here after the first alert is triggered.')}</p>
					</div>
				{:else}
					<div class="history-list">
						{#each history.items as item (item.id)}
							<article class="history-item">
								<div class="history-heading">
									<div>
										<strong>{item.categoryName}</strong>
										<span>{item.recipientLabel}</span>
									</div>
									<span class={['status-pill', statusTone(item.status)]}>
										{statusLabel(item.status)}
									</span>
								</div>
								<div class="history-meta">
									<span>{monthLabel(item.periodMonth)}</span>
									<span>{levelLabel(item.level)}</span>
									<span>{stageLabel(item.stage)}</span>
									<span>{t('{count} attempts', { count: item.attemptCount })}</span>
								</div>

								{#if item.status === 'failed'}
									<div class="failure-row" role="alert">
										<div>
											<strong>{errorLabel(item.lastErrorCategory)}</strong>
											<span>
												{t('Last updated')}
												<LocalizedDateTime value={item.updatedAt} width="compact" />
											</span>
										</div>
										{#if item.retryable}
											<form method="post" action="?/retryBudgetAlertDelivery">
												<input type="hidden" name="id" value={item.id} />
												<button class="button secondary" type="submit">
													<RotateCcw size={15} aria-hidden="true" />
													<span>{t('Retry delivery')}</span>
												</button>
											</form>
										{:else}
											<span class="non-retryable">{t('Manual retry unavailable')}</span>
										{/if}
									</div>
								{:else if item.lastProviderEvent}
									<p class="provider-event">
										{providerEventLabel(item.lastProviderEvent)}
										{#if item.lastProviderEventAt}
											<span class="provider-time">
												<LocalizedDateTime value={item.lastProviderEventAt} width="compact" />
											</span>
										{/if}
									</p>
								{:else if item.sentAt}
									<p class="provider-event">
										{t('Sent')}
										<span class="provider-time">
											<LocalizedDateTime value={item.sentAt} width="compact" />
										</span>
									</p>
								{/if}
							</article>
						{/each}
					</div>

					{#if history.nextCursor}
						<nav class="history-pagination" aria-label={t('Alert delivery history pagination')}>
							<a class="button secondary" href={resolve(nextPagePath(history.nextCursor))}>
								<span>{t('Older deliveries')}</span>
								<ChevronRight size={16} aria-hidden="true" />
							</a>
						</nav>
					{/if}
				{/if}
			</section>
		</div>
	{/if}
</section>

<style>
	.notification-center {
		display: grid;
		min-width: 0;
		gap: 1rem;
		border-top: 1px solid var(--color-line-soft);
		padding-top: 1rem;
	}

	.notification-heading,
	.subheading,
	.threshold-heading,
	.history-heading,
	.failure-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.85rem;
	}

	.notification-heading > div,
	.subheading > div,
	.history-heading > div,
	.failure-row > div {
		display: grid;
		min-width: 0;
		gap: 0.2rem;
	}

	h3,
	h4,
	p {
		margin: 0;
	}

	.notification-heading p,
	.subheading p,
	.compact-empty p,
	.choice-row small,
	.switch-row small,
	.recipient-row small,
	.history-heading span,
	.provider-event,
	.failure-row span,
	.non-retryable {
		color: var(--color-muted);
		font-size: 0.82rem;
	}

	.threshold-section,
	.preference-card,
	.history-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		gap: 0.9rem;
		border: 1px solid var(--color-line-soft);
		border-radius: 8px;
		background: var(--color-surface);
		padding: 0.95rem;
	}

	.threshold-list,
	.history-list,
	.recipient-list {
		display: grid;
		gap: 0.7rem;
	}

	.threshold-item {
		display: grid;
		gap: 0.55rem;
		min-width: 0;
	}

	.threshold-item + .threshold-item,
	.history-item + .history-item {
		border-top: 1px solid var(--color-line-soft);
		padding-top: 0.75rem;
	}

	.category-label {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.45rem;
	}

	.threshold-rail {
		position: relative;
		height: 0.65rem;
		overflow: hidden;
		border: 1px solid var(--color-line-soft);
		border-radius: 999px;
		background: var(--color-surface-muted);
	}

	.usage-fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: var(--usage);
		background: var(--color-primary);
	}

	.usage-fill.warning {
		background: var(--color-warning);
	}

	.usage-fill.danger {
		background: var(--color-danger);
	}

	.threshold-marker {
		position: absolute;
		top: -0.2rem;
		bottom: -0.2rem;
		left: var(--threshold);
		width: 2px;
		background: var(--color-ink);
		transform: translateX(-1px);
	}

	.rail-labels {
		position: relative;
		display: flex;
		justify-content: space-between;
		min-height: 1rem;
		color: var(--color-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}

	.rail-labels span:nth-child(2) {
		position: absolute;
		left: var(--threshold);
		transform: translateX(-50%);
		white-space: nowrap;
	}

	.manager-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: start;
		gap: 1rem;
	}

	.preference-card fieldset,
	.recipient-fieldset {
		display: grid;
		gap: 0.55rem;
		min-width: 0;
		margin: 0;
		border: 0;
		padding: 0;
	}

	.preference-card legend {
		margin-bottom: 0.35rem;
		font-size: 0.82rem;
		font-weight: 800;
	}

	.switch-row,
	.choice-row,
	.recipient-row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		border: 1px solid var(--color-line-soft);
		border-radius: 8px;
		padding: 0.7rem;
		cursor: pointer;
	}

	.switch-row {
		justify-content: space-between;
	}

	.switch-row > span,
	.choice-row > span,
	.recipient-row > span {
		display: grid;
		min-width: 0;
		gap: 0.12rem;
	}

	.switch-row input,
	.choice-row input,
	.recipient-row input {
		flex: 0 0 auto;
		width: 2rem;
		height: 2rem;
		accent-color: var(--color-primary);
	}

	.switch-row:focus-within,
	.choice-row:focus-within,
	.recipient-row:focus-within {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.recipient-list {
		max-height: 14rem;
		overflow: auto;
		padding: 0.15rem;
	}

	.form-actions,
	.history-pagination {
		display: flex;
		justify-content: flex-end;
	}

	.history-item {
		display: grid;
		gap: 0.55rem;
		min-width: 0;
	}

	.history-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.65rem;
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	.failure-row {
		align-items: flex-start;
		border-radius: 8px;
		background: var(--color-danger-soft);
		color: var(--color-danger);
		padding: 0.7rem;
	}

	.failure-row span {
		color: inherit;
	}

	.provider-event {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.compact-empty {
		display: grid;
		gap: 0.25rem;
		border-radius: 8px;
		background: var(--color-surface-muted);
		padding: 0.9rem;
		text-align: left;
	}

	@media (max-width: 900px) {
		.manager-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 620px) {
		.notification-heading,
		.threshold-heading,
		.history-heading,
		.failure-row {
			align-items: flex-start;
			flex-direction: column;
		}

		.notification-heading > .status-pill,
		.threshold-heading > .status-pill {
			align-self: flex-start;
		}

		.threshold-section,
		.preference-card,
		.history-card {
			padding: 0.8rem;
		}

		.rail-labels span:nth-child(2) {
			display: none;
		}

		.failure-row form,
		.failure-row .button,
		.form-actions .button,
		.history-pagination,
		.history-pagination .button {
			box-sizing: border-box;
			width: 100%;
		}
	}
</style>
