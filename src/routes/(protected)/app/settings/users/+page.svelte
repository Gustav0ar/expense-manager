<script lang="ts">
	import { translate } from '$lib/i18n';
	import { UserMinus } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	let copied = $state(false);
	let removeDialog: HTMLDialogElement | undefined = $state();
	let pendingRemove = $state<{ id: string; name: string } | null>(null);

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	async function copyInviteUrl() {
		if (!form?.inviteUrl) return;
		try {
			await navigator.clipboard.writeText(form.inviteUrl ?? '');
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// clipboard not available (HTTP, permission denied) — silently fail, don't show "Copied!"
		}
	}

	const captureRemoveDialog: Attachment<HTMLDialogElement> = (element) => {
		removeDialog = element;
		return () => {
			if (removeDialog === element) removeDialog = undefined;
		};
	};

	function openRemoveDialog(id: string, name: string) {
		pendingRemove = { id, name };
		removeDialog?.showModal();
	}

	function closeRemoveDialog() {
		removeDialog?.close();
	}

	function closeRemoveDialogFromBackdrop(event: MouseEvent) {
		if (event.target === removeDialog) closeRemoveDialog();
	}

	function clearRemoveDialog() {
		pendingRemove = null;
	}
</script>

<svelte:head>
	<title>{t('Users')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Access')}</span>
			<h2>{t('Users')}</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger" role="alert">{form.message}</p>
	{/if}

	{#if form?.inviteUrl}
		<div class="notice success invite-url-row">
			<span>{t('Invite link created')}</span>
			<code class="invite-url-code">{form.inviteUrl}</code>
			<button type="button" class="button secondary" onclick={copyInviteUrl}>
				{copied ? t('Copied!') : t('Copy link')}
			</button>
		</div>
	{/if}

	<section class="panel">
		<div class="panel-heading">
			<h3>{t('Invite')}</h3>
		</div>
		<form method="post" action="?/invite" class="form-grid compact">
			<label>
				<span>Email</span>
				<input name="email" type="email" required />
			</label>
			<label>
				<span>{t('Role')}</span>
				<select name="role">
					<option value="member">Member</option>
					<option value="viewer">Viewer</option>
					<option value="admin">Admin</option>
				</select>
			</label>
			<button class="button primary align-end" type="submit">{t('Invite')}</button>
		</form>
	</section>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Members')}</h3>
			</div>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>{t('Name')}</th>
							<th>Email</th>
							<th>{t('Role')}</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.members as member (member.id)}
							<tr>
								<td data-label={t('Name')}>{member.name}</td>
								<td data-label="Email">{member.email}</td>
								<td data-label={t('Role')}>
									{#if member.role === 'owner'}
										owner
									{:else}
										<form method="post" action="?/changeRole" class="inline-form">
											<input type="hidden" name="id" value={member.id} />
											<select name="role">
												<option value="admin" selected={member.role === 'admin'}>admin</option>
												<option value="member" selected={member.role === 'member'}>member</option>
												<option value="viewer" selected={member.role === 'viewer'}>viewer</option>
											</select>
											<button class="button secondary" type="submit">{t('Save')}</button>
										</form>
									{/if}
								</td>
								<td data-label={t('Actions')}>
									{#if member.role !== 'owner'}
										<button
											type="button"
											class="text-button danger"
											onclick={() => openRemoveDialog(member.id, member.name)}
										>{t('Remove')}</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Invitations')}</h3>
			</div>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Email</th>
							<th>{t('Role')}</th>
							<th>Status</th>
						</tr>
					</thead>
					<tbody>
						{#each data.invitations as invitation (invitation.id)}
							<tr>
								<td data-label="Email">{invitation.email}</td>
								<td data-label={t('Role')}>{invitation.role}</td>
								<td data-label="Status">{invitation.status}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>

	<dialog
		{@attach captureRemoveDialog}
		class="app-dialog"
		aria-labelledby="remove-member-title"
		onclick={closeRemoveDialogFromBackdrop}
		onclose={clearRemoveDialog}
	>
		{#if pendingRemove}
			<div class="dialog-card">
				<div class="dialog-heading">
					<span class="dialog-icon danger">
						<UserMinus size={20} />
					</span>
					<div>
						<h3 id="remove-member-title">{t('Remove member?')}</h3>
						<p>{pendingRemove.name}</p>
					</div>
				</div>

				<p class="dialog-muted">
					{t('Remove {name} from the workspace? They will lose access immediately.', { name: pendingRemove.name })}
				</p>

				<form method="post" action="?/remove" class="dialog-actions">
					<input type="hidden" name="id" value={pendingRemove.id} />
					<button class="button secondary" type="button" onclick={closeRemoveDialog}
						>{t('Cancel')}</button
					>
					<button class="button danger" type="submit">
						<UserMinus size={17} />
						<span>{t('Remove')}</span>
					</button>
				</form>
			</div>
		{/if}
	</dialog>
</section>
