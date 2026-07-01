import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { defaultLocale, translate, type SupportedLocale } from '$lib/i18n';
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

export async function sendPasswordResetEmail(
	to: string,
	url: string,
	locale: SupportedLocale = defaultLocale
) {
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: translate(locale, 'Password reset'),
		text: translate(locale, 'Access the link to reset your password: {url}', { url: textUrl }),
		html: `<p>${escapeHtml(translate(locale, 'Access the link to reset your password: {url}', { url: '' }).trim())}</p><p><a href="${safeUrl}">${safeUrl}</a></p>`
	});
}

export async function sendVerificationEmail(
	to: string,
	url: string,
	locale: SupportedLocale = defaultLocale
) {
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: translate(locale, 'Verify your email'),
		text: translate(locale, 'Access the link to verify your email: {url}', { url: textUrl }),
		html: `<p>${escapeHtml(translate(locale, 'Access the link to verify your email: {url}', { url: '' }).trim())}</p><p><a href="${safeUrl}">${safeUrl}</a></p>`
	});
}

export async function sendInvitationEmail(
	to: string,
	workspaceName: string,
	url: string,
	locale: SupportedLocale = defaultLocale
) {
	const safeTextWorkspaceName = sanitizeEmailText(workspaceName);
	const safeWorkspaceName = escapeHtml(safeTextWorkspaceName);
	const textUrl = sanitizeEmailText(url);
	const safeUrl = escapeHtml(textUrl);
	await sendMail({
		to,
		subject: translate(locale, 'Invite to {workspace}', { workspace: safeTextWorkspaceName }),
		text: translate(locale, 'You received an invite to access {workspace}. Open: {url}', {
			workspace: safeTextWorkspaceName,
			url: textUrl
		}),
		html: `<p>${escapeHtml(
			translate(locale, 'You received an invite to access {workspace}. Open: {url}', {
				workspace: safeTextWorkspaceName,
				url: ''
			}).trim()
		)}</p><p><strong>${safeWorkspaceName}</strong></p><p><a href="${safeUrl}">${escapeHtml(
			translate(locale, 'Accept invite')
		)}</a></p>`
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
	}>,
	locale: SupportedLocale = defaultLocale
) {
	const safeTextWorkspaceName = sanitizeEmailText(workspaceName);
	const safePeriod = sanitizeEmailText(periodMonth);
	const lines = items.map(
		(item) =>
			`- ${sanitizeEmailText(item.categoryName)}: ${item.usagePct ?? 0}% (${translate(locale, '{spent} of {budget}', { spent: sanitizeEmailText(item.spentLabel), budget: sanitizeEmailText(item.budgetLabel) })})`
	);
	const htmlItems = items
		.map(
			(item) =>
				`<li><strong>${escapeHtml(sanitizeEmailText(item.categoryName))}</strong>: ${
					item.usagePct ?? 0
				}% (${escapeHtml(
					translate(locale, '{spent} of {budget}', {
						spent: sanitizeEmailText(item.spentLabel),
						budget: sanitizeEmailText(item.budgetLabel)
					})
				)})</li>`
		)
		.join('');

	await sendMail({
		to,
		subject: translate(locale, 'Budget alerts - {workspace}', { workspace: safeTextWorkspaceName }),
		text: `${translate(locale, 'Budget alerts for {workspace} in {period}:', {
			workspace: safeTextWorkspaceName,
			period: safePeriod
		})}\n${lines.join('\n')}`,
		html: `<p>${escapeHtml(
			translate(locale, 'Budget alerts for {workspace} in {period}:', {
				workspace: safeTextWorkspaceName,
				period: safePeriod
			})
		)}</p><ul>${htmlItems}</ul>`
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
