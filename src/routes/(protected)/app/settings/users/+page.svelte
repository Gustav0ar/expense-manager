<script lang="ts">
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function translateRole(role: string) {
		const map: Record<string, string> = {
			owner: t('Owner'),
			admin: t('Admin'),
			member: t('Member'),
			viewer: t('Viewer')
		};
		return map[role] ?? role;
	}

	function translateInvitationStatus(status: string) {
		const map: Record<string, string> = {
			pending: t('Pending'),
			accepted: t('Accepted'),
			revoked: t('Revoked'),
			expired: t('Expired')
		};
		return map[status] ?? status;
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
		<p class="notice danger">{form.message}</p>
	{/if}

	{#if form?.inviteUrl}
		<p class="notice success">{t('Invite created: {url}', { url: form.inviteUrl })}</p>
	{/if}

	<section class="panel">
		<div class="panel-heading">
			<h3>{t('Invite')}</h3>
		</div>
		<form method="post" action="?/invite" class="form-grid compact">
			<label>
				<span>{t('Email')}</span>
				<input name="email" type="email" required />
			</label>
			<label>
				<span>{t('Role')}</span>
				<select name="role">
					<option value="member">{t('Member')}</option>
					<option value="viewer">{t('Viewer')}</option>
					<option value="admin">{t('Admin')}</option>
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
							<th>{t('Email')}</th>
							<th>{t('Role')}</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.members as member (member.id)}
							<tr>
								<td data-label={t('Name')}>{member.name}</td>
								<td data-label={t('Email')}>{member.email}</td>
								<td data-label={t('Role')}>
									{#if member.role === 'owner'}
										{t('Owner')}
									{:else}
										<form method="post" action="?/changeRole" class="inline-form">
											<input type="hidden" name="id" value={member.id} />
											<select name="role">
												<option value="admin" selected={member.role === 'admin'}
													>{t('Admin')}</option
												>
												<option value="member" selected={member.role === 'member'}
													>{t('Member')}</option
												>
												<option value="viewer" selected={member.role === 'viewer'}
													>{t('Viewer')}</option
												>
											</select>
											<button class="button secondary" type="submit">{t('Save')}</button>
										</form>
									{/if}
								</td>
								<td data-label={t('Actions')}>
									{#if member.role !== 'owner'}
										<form method="post" action="?/remove">
											<input type="hidden" name="id" value={member.id} />
											<button class="text-button danger" type="submit">{t('Remove')}</button>
										</form>
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
							<th>{t('Email')}</th>
							<th>{t('Role')}</th>
							<th>{t('Status')}</th>
						</tr>
					</thead>
					<tbody>
						{#each data.invitations as invitation (invitation.id)}
							<tr>
								<td data-label={t('Email')}>{invitation.email}</td>
								<td data-label={t('Role')}>{translateRole(invitation.role)}</td>
								<td data-label={t('Status')}>{translateInvitationStatus(invitation.status)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>
</section>
