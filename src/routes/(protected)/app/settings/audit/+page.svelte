<script lang="ts">
	import { resolve } from '$app/paths';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { translate } from '$lib/i18n';
	import { ArrowLeft } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const auditPath = resolve('/app/settings/audit');

	function metadataLabel(metadata: unknown) {
		if (!metadata || typeof metadata !== 'object') return '-';
		return JSON.stringify(metadata);
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function auditPageHref(cursor: string) {
		const params = [
			['cursor', cursor],
			['action', data.filters.action],
			['entityType', data.filters.entityType]
		]
			.filter((entry): entry is [string, string] => Boolean(entry[1]))
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
			.join('&');
		return `${auditPath}?${params}`;
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
			<label>
				<span>{t('Action')}</span>
				<input name="action" value={data.filters.action ?? ''} placeholder="expense.created" />
			</label>
			<label>
				<span>{t('Entity')}</span>
				<input name="entityType" value={data.filters.entityType ?? ''} placeholder="expense" />
			</label>
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
						<tr>
							<td data-label={t('Date')}
								><LocalizedDateTime value={item.createdAt} width="compact" /></td
							>
							<td data-label={t('Action')}><code>{item.action}</code></td>
							<td data-label={t('Entity')}
								>{item.entityType}{item.entityId ? ` #${item.entityId}` : ''}</td
							>
							<td data-label={t('Actor')}>{item.actorUserId ?? '-'}</td>
							<td class="metadata-cell" data-label={t('Metadata')}
								>{metadataLabel(item.metadata)}</td
							>
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
			<a class="button secondary" href={auditPageHref(data.audit.nextCursor)}>{t('Next page')}</a>
		{/if}
	</section>
</section>
