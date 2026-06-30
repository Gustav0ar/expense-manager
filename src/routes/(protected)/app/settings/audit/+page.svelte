<script lang="ts">
	import { resolve } from '$app/paths';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const auditPath = resolve('/app/settings/audit');

	function metadataLabel(metadata: unknown) {
		if (!metadata || typeof metadata !== 'object') return '-';
		return JSON.stringify(metadata);
	}
</script>

<svelte:head>
	<title>Auditoria | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Seguranca</span>
			<h2>Auditoria</h2>
		</div>
	</div>

	<section class="panel">
		<form method="get" class="form-grid compact">
			<label>
				<span>Acao</span>
				<input name="action" value={data.filters.action ?? ''} placeholder="expense.created" />
			</label>
			<label>
				<span>Entidade</span>
				<input name="entityType" value={data.filters.entityType ?? ''} placeholder="expense" />
			</label>
			<button class="button primary align-end" type="submit">Filtrar</button>
			<a class="button secondary align-end" href={auditPath}>Limpar</a>
		</form>
	</section>

	<section class="panel">
		<div class="panel-heading">
			<h3>Eventos</h3>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Data</th>
						<th>Acao</th>
						<th>Entidade</th>
						<th>Actor</th>
						<th>Metadata</th>
					</tr>
				</thead>
				<tbody>
					{#each data.audit.items as item (item.id)}
						<tr>
							<td><LocalizedDateTime value={item.createdAt} width="compact" /></td>
							<td><code>{item.action}</code></td>
							<td>{item.entityType}{item.entityId ? ` #${item.entityId}` : ''}</td>
							<td>{item.actorUserId ?? '-'}</td>
							<td class="metadata-cell">{metadataLabel(item.metadata)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5">Nenhum evento encontrado.</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.audit.nextCursor}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="button secondary" href={`${auditPath}?cursor=${data.audit.nextCursor}`}
				>Proxima pagina</a
			>
		{/if}
	</section>
</section>
