import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import nodemailer from 'nodemailer';

type MailInput = {
	to: string;
	subject: string;
	text: string;
	html?: string;
};

function smtpConfigured() {
	return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
}

export async function sendMail(input: MailInput) {
	if (!smtpConfigured()) {
		if (dev || env.EMAIL_DELIVERY === 'log') {
			console.info('[email:dev]', {
				to: input.to,
				subject: input.subject,
				text: input.text
			});
			return;
		}

		throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT and SMTP_FROM.');
	}

	const transporter = nodemailer.createTransport({
		host: env.SMTP_HOST,
		port: Number.parseInt(env.SMTP_PORT, 10),
		secure: env.SMTP_SECURE === 'true',
		auth:
			env.SMTP_USER && env.SMTP_PASSWORD
				? {
						user: env.SMTP_USER,
						pass: env.SMTP_PASSWORD
					}
				: undefined
	});

	await transporter.sendMail({
		from: env.SMTP_FROM,
		to: input.to,
		subject: input.subject,
		text: input.text,
		html: input.html
	});
}

export async function sendPasswordResetEmail(to: string, url: string) {
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: 'Redefinição de senha',
		text: `Acesse o link para redefinir sua senha: ${textUrl}`,
		html: `<p>Acesse o link para redefinir sua senha:</p><p><a href="${safeUrl}">${safeUrl}</a></p>`
	});
}

export async function sendVerificationEmail(to: string, url: string) {
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: 'Verifique seu email',
		text: `Acesse o link para verificar seu email: ${textUrl}`,
		html: `<p>Acesse o link para verificar seu email:</p><p><a href="${safeUrl}">${safeUrl}</a></p>`
	});
}

export async function sendInvitationEmail(to: string, workspaceName: string, url: string) {
	const safeWorkspaceName = escapeHtml(sanitizeEmailText(workspaceName));
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: `Convite para ${safeWorkspaceName}`,
		text: `Você recebeu um convite para acessar ${safeWorkspaceName}. Acesse: ${textUrl}`,
		html: `<p>Você recebeu um convite para acessar <strong>${safeWorkspaceName}</strong>.</p><p><a href="${safeUrl}">Aceitar convite</a></p>`
	});
}

export async function sendBudgetAlertEmail(
	to: string,
	workspaceName: string,
	periodMonth: string,
	items: Array<{
		categoryName: string;
		usagePct: number | null;
		spentLabel: string;
		budgetLabel: string;
		status: string;
	}>
) {
	const safeWorkspaceName = escapeHtml(sanitizeEmailText(workspaceName));
	const safePeriod = sanitizeEmailText(periodMonth);
	const lines = items.map(
		(item) =>
			`- ${sanitizeEmailText(item.categoryName)}: ${item.usagePct ?? 0}% (${sanitizeEmailText(
				item.spentLabel
			)} de ${sanitizeEmailText(item.budgetLabel)})`
	);
	const htmlItems = items
		.map(
			(item) =>
				`<li><strong>${escapeHtml(sanitizeEmailText(item.categoryName))}</strong>: ${
					item.usagePct ?? 0
				}% (${escapeHtml(sanitizeEmailText(item.spentLabel))} de ${escapeHtml(
					sanitizeEmailText(item.budgetLabel)
				)})</li>`
		)
		.join('');

	await sendMail({
		to,
		subject: `Alertas de orçamento - ${safeWorkspaceName}`,
		text: `Alertas de orçamento para ${safeWorkspaceName} em ${safePeriod}:\n${lines.join('\n')}`,
		html: `<p>Alertas de orçamento para <strong>${safeWorkspaceName}</strong> em ${escapeHtml(safePeriod)}:</p><ul>${htmlItems}</ul>`
	});
}

export function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

export function sanitizeEmailText(value: string) {
	return value.replace(/[\r\n]+/g, ' ').trim();
}
