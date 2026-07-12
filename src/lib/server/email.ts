import { dev } from '$app/environment';
import { defaultLocale, translate, type SupportedLocale } from '$lib/i18n';
import { getPrivateEnv, getPrivateSecret } from '$lib/server/config';
import nodemailer from 'nodemailer';

type MailInput = {
	to: string;
	subject: string;
	text: string;
	html?: string;
	customId?: string;
	redactBodyInLogs?: boolean;
};

type MailProvider = 'auto' | 'mailjet' | 'sender' | 'smtp' | 'log';

export type MailDeliveryReceipt = {
	provider: Exclude<MailProvider, 'auto'>;
	messageId?: string;
	messageUuid?: string;
};

export const defaultEmailDeliveryTimeoutMs = 15_000;
export const defaultEmailDeliveryConcurrency = 5;

export function emailDeliveryTimeoutMs() {
	return boundedIntegerEnv(
		'EMAIL_DELIVERY_TIMEOUT_MS',
		defaultEmailDeliveryTimeoutMs,
		1000,
		120_000
	);
}

export function emailDeliveryConcurrency() {
	return boundedIntegerEnv('EMAIL_DELIVERY_CONCURRENCY', defaultEmailDeliveryConcurrency, 1, 20);
}

function configuredProvider(): MailProvider {
	const provider = (getPrivateEnv('EMAIL_PROVIDER') || 'auto').trim().toLowerCase();
	if (
		provider === 'mailjet' ||
		provider === 'sender' ||
		provider === 'smtp' ||
		provider === 'log'
	) {
		return provider;
	}
	return 'auto';
}

function mailjetApiConfigured() {
	return Boolean(
		getPrivateSecret('MAILJET_API_KEY') &&
		getPrivateSecret('MAILJET_SECRET_KEY') &&
		getPrivateEnv('MAILJET_FROM')
	);
}

function senderApiConfigured() {
	return Boolean(getPrivateSecret('SENDER_API_TOKEN') && getPrivateEnv('SENDER_FROM'));
}

export async function sendMail(input: MailInput): Promise<MailDeliveryReceipt> {
	const provider = configuredProvider();

	if (provider === 'log') {
		logEmail(input);
		return { provider: 'log' } satisfies MailDeliveryReceipt;
	}

	if (provider === 'mailjet') {
		if (!mailjetApiConfigured()) {
			throw new Error(
				'Mailjet email delivery is not configured. Set MAILJET_API_KEY, MAILJET_SECRET_KEY and MAILJET_FROM.'
			);
		}
		return sendMailjetApiMail(input);
	}

	if (provider === 'sender') {
		if (!senderApiConfigured()) {
			throw new Error(
				'Sender email delivery is not configured. Set SENDER_API_TOKEN and SENDER_FROM.'
			);
		}
		return sendSenderApiMail(input);
	}

	if (provider === 'auto' && mailjetApiConfigured()) {
		return sendMailjetApiMail(input);
	}

	if (provider === 'auto' && senderApiConfigured()) {
		return sendSenderApiMail(input);
	}

	return sendSmtpMail(input, provider);
}

async function sendSmtpMail(input: MailInput, provider: MailProvider) {
	const smtpHost = getPrivateEnv('SMTP_HOST');
	const smtpPort = getPrivateEnv('SMTP_PORT');
	const smtpFrom = getPrivateEnv('SMTP_FROM');

	if (!smtpHost || !smtpPort || !smtpFrom) {
		if (provider === 'smtp') {
			throw new Error(
				'SMTP email delivery is not configured. Set SMTP_HOST, SMTP_PORT and SMTP_FROM.'
			);
		}

		if (dev || getPrivateEnv('EMAIL_DELIVERY') === 'log') {
			logEmail(input);
			return { provider: 'log' } satisfies MailDeliveryReceipt;
		}

		throw new Error(
			'Email delivery is not configured. Set EMAIL_PROVIDER=mailjet with MAILJET_API_KEY, MAILJET_SECRET_KEY and MAILJET_FROM, or configure Sender/SMTP.'
		);
	}

	const transporter = nodemailer.createTransport({
		host: smtpHost,
		port: Number.parseInt(smtpPort, 10),
		secure: getPrivateEnv('SMTP_SECURE') === 'true',
		connectionTimeout: emailDeliveryTimeoutMs(),
		greetingTimeout: emailDeliveryTimeoutMs(),
		socketTimeout: emailDeliveryTimeoutMs(),
		auth:
			getPrivateEnv('SMTP_USER') && getPrivateSecret('SMTP_PASSWORD')
				? {
						user: getPrivateEnv('SMTP_USER'),
						pass: getPrivateSecret('SMTP_PASSWORD')
					}
				: undefined
	});

	const result = await transporter.sendMail({
		from: smtpFrom,
		to: input.to,
		subject: input.subject,
		text: input.text,
		html: input.html
	});
	return {
		provider: 'smtp',
		...(result?.messageId ? { messageId: result.messageId } : {})
	} satisfies MailDeliveryReceipt;
}

function logEmail(input: MailInput) {
	console.info('[email:dev]', {
		to: input.to,
		subject: input.subject,
		text: input.redactBodyInLogs ? '[redacted sensitive email body]' : input.text
	});
}

async function sendMailjetApiMail(input: MailInput) {
	const from = parseMailbox(getPrivateEnv('MAILJET_FROM') || '');
	const authorization = Buffer.from(
		`${getPrivateSecret('MAILJET_API_KEY')}:${getPrivateSecret('MAILJET_SECRET_KEY')}`
	).toString('base64');
	const response = await fetch('https://api.mailjet.com/v3.1/send', {
		signal: AbortSignal.timeout(emailDeliveryTimeoutMs()),
		method: 'POST',
		headers: {
			Accept: 'application/json',
			Authorization: `Basic ${authorization}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			Messages: [
				{
					From: toMailjetContact(from),
					To: [{ Email: input.to }],
					Subject: input.subject,
					TextPart: input.text,
					...(input.customId ? { CustomID: input.customId } : {}),
					...(input.html ? { HTMLPart: input.html } : {})
				}
			]
		})
	});

	if (!response.ok) {
		const body = (await response.text()).slice(0, 500);
		throw new Error(`Mailjet API failed with HTTP ${response.status}: ${body}`);
	}

	const responseBody = (await response.json().catch(() => null)) as {
		Messages?: Array<{
			To?: Array<{
				MessageID?: string | number;
				MessageUUID?: string;
			}>;
		}>;
	} | null;
	const recipient = responseBody?.Messages?.[0]?.To?.[0];
	const messageId = normalizeProviderMessageId(recipient?.MessageID);
	return {
		provider: 'mailjet',
		...(messageId ? { messageId } : {}),
		...(recipient?.MessageUUID ? { messageUuid: recipient.MessageUUID } : {})
	} satisfies MailDeliveryReceipt;
}

async function sendSenderApiMail(input: MailInput) {
	const from = parseMailbox(getPrivateEnv('SENDER_FROM') || '');
	const response = await fetch('https://api.sender.net/v2/message/send', {
		signal: AbortSignal.timeout(emailDeliveryTimeoutMs()),
		method: 'POST',
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${getPrivateSecret('SENDER_API_TOKEN')}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from,
			to: {
				email: input.to
			},
			subject: input.subject,
			text: input.text,
			...(input.html ? { html: input.html } : {})
		})
	});

	if (!response.ok) {
		const body = (await response.text()).slice(0, 500);
		throw new Error(`Sender API failed with HTTP ${response.status}: ${body}`);
	}
	return { provider: 'sender' } satisfies MailDeliveryReceipt;
}

function boundedIntegerEnv(key: string, fallback: number, minimum: number, maximum: number) {
	const parsed = Number.parseInt(getPrivateEnv(key) || '', 10);
	return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

export function parseMailbox(value: string) {
	const trimmed = value.trim();
	const namedMatch = trimmed.match(/^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/);
	if (namedMatch) {
		return {
			email: namedMatch[2],
			name: namedMatch[1].replace(/^"|"$/g, '').trim()
		};
	}

	return { email: trimmed };
}

function toMailjetContact(mailbox: ReturnType<typeof parseMailbox>) {
	return {
		Email: mailbox.email,
		Name: mailbox.name || 'Expense Manager'
	};
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
	return sendMail({
		to,
		redactBodyInLogs: true,
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
	locale: SupportedLocale = defaultLocale,
	customId?: string
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

	return sendMail({
		to,
		customId,
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

function normalizeProviderMessageId(value: string | number | undefined) {
	if (typeof value === 'string' && value) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
	return undefined;
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
