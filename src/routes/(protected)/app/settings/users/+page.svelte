<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
</script>

<svelte:head>
	<title>Usuarios | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Acesso</span>
			<h2>Usuarios</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger">{form.message}</p>
	{/if}

	{#if form?.inviteUrl}
		<p class="notice success">Convite criado: {form.inviteUrl}</p>
	{/if}

	<section class="panel">
		<div class="panel-heading">
			<h3>Convidar</h3>
		</div>
		<form method="post" action="?/invite" class="form-grid compact">
			<label>
				<span>Email</span>
				<input name="email" type="email" required />
			</label>
			<label>
				<span>Papel</span>
				<select name="role">
					<option value="member">Member</option>
					<option value="viewer">Viewer</option>
					<option value="admin">Admin</option>
				</select>
			</label>
			<button class="button primary align-end" type="submit">Convidar</button>
		</form>
	</section>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Membros</h3>
			</div>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Nome</th>
							<th>Email</th>
							<th>Papel</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.members as member (member.id)}
							<tr>
								<td>{member.name}</td>
								<td>{member.email}</td>
								<td>
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
											<button class="button secondary" type="submit">Salvar</button>
										</form>
									{/if}
								</td>
								<td>
									{#if member.role !== 'owner'}
										<form method="post" action="?/remove">
											<input type="hidden" name="id" value={member.id} />
											<button class="text-button danger" type="submit">Remover</button>
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
				<h3>Convites</h3>
			</div>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Email</th>
							<th>Papel</th>
							<th>Status</th>
						</tr>
					</thead>
					<tbody>
						{#each data.invitations as invitation (invitation.id)}
							<tr>
								<td>{invitation.email}</td>
								<td>{invitation.role}</td>
								<td>{invitation.status}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>
</section>
