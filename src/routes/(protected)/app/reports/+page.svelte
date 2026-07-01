<script lang="ts">
	import { resolve } from '$app/paths';
	import BarList from '$lib/components/BarList.svelte';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import type { PageData } from './$types';

	type Analytics = NonNullable<PageData['analytics']>;
	type AnalyticsRow = Analytics['items'][number];

	let { data } = $props<{ data: PageData }>();
	const exportPath = resolve('/app/reports/export.csv');
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const isAnalytical = $derived(data.filters.groupBy === 'expense');
	const analytics = $derived(data.analytics);
	const reportPeriod = $derived(
		data.filters.groupBy === 'week' ||
			data.filters.groupBy === 'month' ||
			data.filters.groupBy === 'year'
			? data.filters.groupBy
			: undefined
	);
	const exportUrl = $derived(createExportUrl(data.filters));

	function createExportUrl(filters: PageData['filters']) {
		const params = [
			queryParam('from', filters.from),
			queryParam('to', filters.to),
			queryParam('groupBy', filters.groupBy)
		];

		if (filters.categoryId) params.push(queryParam('categoryId', String(filters.categoryId)));
		if (filters.vendorId) params.push(queryParam('vendorId', String(filters.vendorId)));
		if (filters.costCenterId) params.push(queryParam('costCenterId', String(filters.costCenterId)));
		if (filters.competencyMonth)
			params.push(queryParam('competencyMonth', filters.competencyMonth));
		if (filters.reviewStatus) params.push(queryParam('reviewStatus', filters.reviewStatus));
		if (filters.paymentStatus) params.push(queryParam('paymentStatus', filters.paymentStatus));
		if (filters.q) params.push(queryParam('q', filters.q));

		return `${exportPath}?${params.join('&')}`;
	}

	function queryParam(key: string, value: string) {
		return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
	}

	function categoryLabel(row: AnalyticsRow) {
		return `${row.categoryIcon ? `${row.categoryIcon} ` : ''}${row.categoryName}`;
	}

	function optionalValue(value: string | null) {
		return value?.trim() ? value : '-';
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}

	function catalogOptions(items: { id: number; name: string }[]) {
		return items.map((item) => ({ id: item.id, label: item.name }));
	}

	function installmentLabel(row: AnalyticsRow) {
		return row.installmentNumber && row.installmentsTotal
			? `${row.installmentNumber}/${row.installmentsTotal}`
			: '-';
	}

	function reviewLabel(value: AnalyticsRow['reviewStatus']) {
		if (value === 'pending') return t('Pending');
		if (value === 'rejected') return t('Rejected');
		return t('Approved');
	}

	function reviewClass(value: AnalyticsRow['reviewStatus']) {
		if (value === 'pending') return 'status-pill warning';
		if (value === 'rejected') return 'status-pill danger';
		return 'status-pill success';
	}

	function paymentLabel(value: AnalyticsRow['paymentStatus']) {
		if (value === 'paid') return t('Paid');
		if (value === 'reconciled') return t('Reconciled');
		return t('Open');
	}

	function paymentClass(value: AnalyticsRow['paymentStatus']) {
		if (value === 'paid') return 'status-pill info';
		if (value === 'reconciled') return 'status-pill success';
		return 'status-pill neutral';
	}
</script>

<svelte:head>
	<title>{t('Reports')} | Expense Manager</title>
</svelte:head>

<section class="page-section printable">
	<div class="section-heading no-print">
		<div>
			<span class="eyebrow">{t('Analysis')}</span>
			<h2>{t('Reports')}</h2>
		</div>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="button secondary" href={exportUrl}>CSV</a>
	</div>

	<section class="panel no-print">
		<form method="get" class="form-grid compact">
			<label>
				<span>{t('Start')}</span>
				<input type="date" name="from" value={data.filters.from} />
			</label>
			<label>
				<span>{t('End')}</span>
				<input type="date" name="to" value={data.filters.to} />
			</label>
			<label>
				<span>{t('Group by')}</span>
				<select name="groupBy">
					<option value="category" selected={data.filters.groupBy === 'category'}
						>{t('Category')}</option
					>
					<option value="week" selected={data.filters.groupBy === 'week'}>{t('Week')}</option>
					<option value="month" selected={data.filters.groupBy === 'month'}>{t('Month')}</option>
					<option value="year" selected={data.filters.groupBy === 'year'}>{t('Year')}</option>
					<option value="payment" selected={data.filters.groupBy === 'payment'}
						>{t('Payment')}</option
					>
					<option value="expense" selected={data.filters.groupBy === 'expense'}
						>{t('Analytical')}</option
					>
				</select>
			</label>
			<label>
				<span>{t('Category')}</span>
				<select name="categoryId">
					<option value="">{t('All categories')}</option>
					{#each data.categories as category (category.id)}
						<option value={category.id} selected={data.filters.categoryId === category.id}
							>{category.name}</option
						>
					{/each}
				</select>
			</label>
			<SearchableSelect
				id="report-filter-vendor"
				name="vendorId"
				label={t('Vendor')}
				options={catalogOptions(data.catalogs.vendors)}
				selectedId={data.filters.vendorId}
				placeholder={t('All')}
				empty={t('No vendor found.')}
				locale={data.locale}
			/>
			<SearchableSelect
				id="report-filter-cost-center"
				name="costCenterId"
				label={t('Cost center')}
				options={catalogOptions(data.catalogs.costCenters)}
				selectedId={data.filters.costCenterId}
				placeholder={t('All')}
				empty={t('No cost center found.')}
				locale={data.locale}
			/>
			<label>
				<span>{t('Competency')}</span>
				<input
					type="month"
					name="competencyMonth"
					value={data.filters.competencyMonth?.slice(0, 7) ?? ''}
				/>
			</label>
			{#if isAnalytical}
				<label>
					<span>{t('Review')}</span>
					<select name="reviewStatus">
						<option value="">{t('All reviews')}</option>
						<option value="pending" selected={data.filters.reviewStatus === 'pending'}
							>{t('Pending expenses')}</option
						>
						<option value="approved" selected={data.filters.reviewStatus === 'approved'}
							>{t('Approved expenses')}</option
						>
						<option value="rejected" selected={data.filters.reviewStatus === 'rejected'}
							>{t('Rejected expenses')}</option
						>
					</select>
				</label>
				<label>
					<span>{t('Payment')}</span>
					<select name="paymentStatus">
						<option value="">{t('All payments')}</option>
						<option value="unpaid" selected={data.filters.paymentStatus === 'unpaid'}
							>{t('Open')}</option
						>
						<option value="paid" selected={data.filters.paymentStatus === 'paid'}
							>{t('Paid')}</option
						>
						<option value="reconciled" selected={data.filters.paymentStatus === 'reconciled'}
							>{t('Reconciled')}</option
						>
					</select>
				</label>
				<label class="report-search-field">
					<span>{t('Search')}</span>
					<input name="q" type="search" value={data.filters.q ?? ''} autocomplete="off" />
				</label>
			{/if}
			<button class="button primary align-end" type="submit">{t('Generate')}</button>
		</form>
	</section>

	{#if isAnalytical}
		{#if analytics}
			<section class="metric-grid report-summary-grid">
				<section class="metric-card">
					<span>{t('Expenses')}</span>
					<strong>{analytics.summary.itemCount}</strong>
					<small>{money(analytics.summary.totalCents)}</small>
				</section>
				<section class="metric-card">
					<span>{t('Approved expenses')}</span>
					<strong>{money(analytics.summary.approvedCents)}</strong>
					<small
						>{t('{value} reconciled', { value: money(analytics.summary.reconciledCents) })}</small
					>
				</section>
				<section class="metric-card">
					<span>{t('Pending expenses')}</span>
					<strong>{money(analytics.summary.pendingCents)}</strong>
					<small>{t('{value} open', { value: money(analytics.summary.unpaidCents) })}</small>
				</section>
				<section class="metric-card">
					<span>{t('Rejected expenses')}</span>
					<strong>{money(analytics.summary.rejectedCents)}</strong>
					<small>{t('{value} paid', { value: money(analytics.summary.paidCents) })}</small>
				</section>
			</section>

			<section class="panel">
				<div class="panel-heading">
					<h3>{t('Analytical')}</h3>
					{#if analytics.truncated}
						<span class="eyebrow">{t('First {limit}', { limit: analytics.limit })}</span>
					{/if}
				</div>

				{#if analytics.items.length === 0}
					<p class="empty">{t('No expenses in the period.')}</p>
				{:else}
					<div class="table-wrap analytical-report-table">
						<table>
							<thead>
								<tr>
									<th>{t('Date')}</th>
									<th>{t('Competency')}</th>
									<th>{t('Description')}</th>
									<th>{t('Category')}</th>
									<th>{t('Vendor')}</th>
									<th>{t('Center')}</th>
									<th>{t('Payment')}</th>
									<th>{t('Review')}</th>
									<th>{t('Status')}</th>
									<th>{t('Installment')}</th>
									<th>{t('Attachments')}</th>
									<th>{t('Value')}</th>
									<th>{t('Notes')}</th>
								</tr>
							</thead>
							<tbody>
								{#each analytics.items as row (row.id)}
									<tr>
										<td data-label={t('Date')}>
											<LocalizedDate value={row.expenseDate} width="compact" />
										</td>
										<td data-label={t('Competency')}>
											{#if row.competencyMonth}
												<LocalizedDate value={row.competencyMonth} period="month" width="compact" />
											{:else}
												-
											{/if}
										</td>
										<td data-label={t('Description')}><strong>{row.description}</strong></td>
										<td data-label={t('Category')}>
											<span class="category-dot" style={`background: ${row.categoryColor}`}></span>
											{categoryLabel(row)}
										</td>
										<td data-label={t('Vendor')}>{optionalValue(row.vendor)}</td>
										<td data-label={t('Center')}>{optionalValue(row.costCenter)}</td>
										<td data-label={t('Payment')}>{optionalValue(row.paymentMethod)}</td>
										<td data-label={t('Review')}>
											<span class={reviewClass(row.reviewStatus)}
												>{reviewLabel(row.reviewStatus)}</span
											>
										</td>
										<td data-label={t('Status')}>
											<span class={paymentClass(row.paymentStatus)}
												>{paymentLabel(row.paymentStatus)}</span
											>
										</td>
										<td data-label={t('Installment')}>{installmentLabel(row)}</td>
										<td data-label={t('Attachments')}>{row.attachmentCount}</td>
										<td class="amount" data-label={t('Value')}>{money(row.amountCents)}</td>
										<td class="report-notes" data-label={t('Notes')}>{optionalValue(row.notes)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}
	{:else}
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Result')}</h3>
			</div>
			<BarList items={data.report} period={reportPeriod} {currency} locale={data.locale} />

			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>{t('Group')}</th>
							<th>{t('Value')}</th>
						</tr>
					</thead>
					<tbody>
						{#each data.report as row (row.key)}
							<tr>
								<td data-label={t('Group')}>
									{#if reportPeriod}
										<LocalizedDate value={row.label} period={reportPeriod} />
									{:else}
										{row.label}
									{/if}
								</td>
								<td class="amount" data-label={t('Value')}>{money(row.totalCents)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</section>
