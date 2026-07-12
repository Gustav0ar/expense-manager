<script lang="ts">
	import { CheckCircle2, CreditCard, XCircle } from '@lucide/svelte';
	import { paymentClass, paymentLabel, reviewClass, reviewLabel } from '$lib/utils/status';
	import type { PageData } from './$types';

	type Translate = (
		key: string,
		params?: Record<string, string | number | null | undefined>
	) => string;

	let { expense, canReview, canReconcile, returnTo, t } = $props<{
		expense: PageData['expenses']['items'][number];
		canReview: boolean;
		canReconcile: boolean;
		returnTo: string;
		t: Translate;
	}>();
</script>

<div class="expense-workflow-panel">
	<div class="workflow-summary">
		<span class={reviewClass(expense.reviewStatus)}>
			{reviewLabel(expense.reviewStatus, t)}
		</span>
		<span class={paymentClass(expense.paymentStatus)}>
			{paymentLabel(expense.paymentStatus, t)}
		</span>
	</div>
	{#if canReview}
		<form method="post" action="?/review" class="workflow-form workflow-approve-form">
			<input type="hidden" name="id" value={expense.id} />
			<input type="hidden" name="returnTo" value={returnTo} />
			<input type="hidden" name="reviewStatus" value="approved" />
			<button
				class="button review-approve"
				type="submit"
				disabled={expense.reviewStatus === 'approved'}
			>
				<CheckCircle2 size={16} />
				<span>{t('Approve')}</span>
			</button>
		</form>
		<form method="post" action="?/review" class="workflow-form reject-form">
			<input type="hidden" name="id" value={expense.id} />
			<input type="hidden" name="returnTo" value={returnTo} />
			<input type="hidden" name="reviewStatus" value="rejected" />
			<input
				name="reason"
				aria-label={t('Rejection reason')}
				placeholder={t('Reason')}
				maxlength="500"
				required
			/>
			<button
				class="button secondary danger"
				type="submit"
				disabled={expense.reviewStatus === 'rejected'}
			>
				<XCircle size={16} />
				<span>{t('Reject')}</span>
			</button>
		</form>
	{/if}

	{#if canReconcile && expense.reviewStatus === 'approved'}
		<form method="post" action="?/payment" class="workflow-form">
			<input type="hidden" name="id" value={expense.id} />
			<input type="hidden" name="returnTo" value={returnTo} />
			<select name="paymentStatus" aria-label={t('Payment status')}>
				<option value="unpaid" selected={expense.paymentStatus === 'unpaid'}>{t('Open')}</option>
				<option value="paid" selected={expense.paymentStatus === 'paid'}>{t('Paid')}</option>
				<option value="reconciled" selected={expense.paymentStatus === 'reconciled'}
					>{t('Reconciled')}</option
				>
			</select>
			<input
				name="paidAt"
				type="date"
				value={expense.paidAt ?? ''}
				aria-label={t('Payment date')}
			/>
			<button class="button secondary" type="submit">
				<CreditCard size={16} />
				<span>{t('Save payment')}</span>
			</button>
		</form>
	{/if}
</div>
