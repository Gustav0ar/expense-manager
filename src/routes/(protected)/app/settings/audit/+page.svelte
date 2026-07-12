<script lang="ts">
	import { resolve } from '$app/paths';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { translate } from '$lib/i18n';
	import {
		auditActionLabel,
		auditEntityLabel,
		auditMetadataValueLabel,
		redactAuditMetadata,
		summarizeAuditMetadata
	} from '$lib/audit-registry';
	import { ArrowLeft } from '@lucide/svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const auditPath = resolve('/app/settings/audit');

	function nextPageHref(cursor: string) {
		const params = new SvelteURLSearchParams();
		if (data.filters.action) params.set('action', data.filters.action);
		if (data.filters.entityType) params.set('entityType', data.filters.entityType);
		params.set('cursor', cursor);
		return `${auditPath}?${params.toString()}`;
	}

	function rawMetadata(metadata: unknown) {
		return JSON.stringify(redactAuditMetadata(metadata), null, 2);
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}
</script>

<svelte:head>
	<title>{t('Audit')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<a class="breadcrumb" href={resolve('/app/settings/workspace')}>
				<ArrowLeft size={13} />
				{t('Settings')}
			</a>
			<span class="eyebrow">{t('Security')}</span>
			<h2>{t('Audit')}</h2>
		</div>
	</div>

	<section class="panel">
		<form method="get" class="form-grid compact">
			<div class="filter-field">
				<label for="audit-action">{t('Action')}</label>
				<select id="audit-action" name="action" value={data.filters.action ?? ''}>
					<option value="">{t('All actions')}</option>
					{#each data.filterOptions.actions as [value, label] (value)}
						<option {value}>{t(label)}</option>
					{/each}
				</select>
			</div>
			<div class="filter-field">
				<label for="audit-entity">{t('Entity')}</label>
				<select id="audit-entity" name="entityType" value={data.filters.entityType ?? ''}>
					<option value="">{t('All entities')}</option>
					{#each data.filterOptions.entityTypes as [value, label] (value)}
						<option {value}>{t(label)}</option>
					{/each}
				</select>
			</div>
			<button class="button primary align-end" type="submit">{t('Filter')}</button>
			<a class="button secondary align-end" href={auditPath}>{t('Clear')}</a>
		</form>
	</section>

	<section class="panel">
		<div class="panel-heading">
			<h3>{t('Events')}</h3>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>{t('Date')}</th>
						<th>{t('Action')}</th>
						<th>{t('Entity')}</th>
						<th>{t('Actor')}</th>
						<th>{t('Metadata')}</th>
					</tr>
				</thead>
				<tbody>
					{#each data.audit.items as item (item.id)}
						{@const metadataSummary = summarizeAuditMetadata(item.metadata)}
						<tr>
							<td data-label={t('Date')}
								><LocalizedDateTime value={item.createdAt} width="compact" /></td
							>
							<td data-label={t('Action')}>
								<span class="audit-label">{t(auditActionLabel(item.action))}</span>
								<code>{item.action}</code>
							</td>
							<td data-label={t('Entity')}
								>{t(auditEntityLabel(item.entityType))}{item.entityId
									? ` #${item.entityId}`
									: ''}</td
							>
							<td data-label={t('Actor')}>
								<span>{item.actorName ?? item.actorUserId ?? t('System')}</span>
								{#if item.actorName && item.actorUserId}
									<code>{item.actorUserId}</code>
								{/if}
							</td>
							<td class="metadata-cell" data-label={t('Metadata')}>
								{#if metadataSummary.length > 0}
									<dl class="metadata-summary">
										{#each metadataSummary as field (field.key)}
											<div>
												<dt>{t(field.label)}</dt>
												<dd>{t(auditMetadataValueLabel(field.key, field.value))}</dd>
											</div>
										{/each}
									</dl>
								{:else}
									<span>—</span>
								{/if}
								{#if item.metadata && typeof item.metadata === 'object'}
									<details>
										<summary>{t('View technical metadata')}</summary>
										<pre>{rawMetadata(item.metadata)}</pre>
									</details>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" data-label={t('Events')}>{t('No events found.')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.audit.nextCursor}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="button secondary" href={nextPageHref(data.audit.nextCursor)}>{t('Next page')}</a>
		{/if}
	</section>
</section>

<style>
	.filter-field {
		display: grid;
		gap: 0.35rem;
	}

	.audit-label,
	td code {
		display: block;
	}

	td code {
		margin-top: 0.2rem;
		font-size: 0.72rem;
		color: var(--color-muted);
		overflow-wrap: anywhere;
	}

	.metadata-cell {
		min-width: 15rem;
	}

	.metadata-summary {
		display: grid;
		gap: 0.25rem;
		margin: 0;
	}

	.metadata-summary div {
		display: grid;
		grid-template-columns: minmax(7rem, auto) 1fr;
		gap: 0.5rem;
	}

	.metadata-summary dt {
		color: var(--color-muted);
	}

	.metadata-summary dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	details {
		margin-top: 0.5rem;
	}

	summary {
		cursor: pointer;
		color: var(--color-muted);
	}

	pre {
		max-width: 28rem;
		max-height: 14rem;
		margin: 0.5rem 0 0;
		padding: 0.65rem;
		overflow: auto;
		border-radius: 0.5rem;
		background: var(--color-surface-muted);
		font-size: 0.72rem;
		white-space: pre-wrap;
	}
</style>
