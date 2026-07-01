import { describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.hoisted(() => vi.fn());
const createTransportMock = vi.hoisted(() =>
	vi.fn(() => ({
		sendMail: sendMailMock
	}))
);
const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('nodemailer', () => ({
	default: {
		createTransport: createTransportMock
	}
}));
vi.mock('$app/environment', () => ({
	browser: false,
	building: false,
	dev: false,
	version: 'test'
}));
vi.mock('$env/dynamic/private', () => ({
	env: privateEnv
}));

import {
	escapeHtml,
	sanitizeEmailText,
	sendBudgetAlertEmail,
	sendInvitationEmail,
	sendMail,
	sendPasswordResetEmail,
	sendVerificationEmail
} from './email';

describe('email helpers', () => {
	it('escapes html-sensitive characters for email markup', () => {
		expect(escapeHtml(`Financeiro <script>"x" & 'y'</script>`)).toBe(
			'Financeiro &lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;'
		);
	});

	it('removes line breaks from user controlled email text', () => {
		expect(sanitizeEmailText('Empresa\r\nBcc: attacker@example.com')).toBe(
			'Empresa Bcc: attacker@example.com'
		);
	});

	it('logs sanitized budget alert emails when SMTP is not configured', async () => {
		const previousDeliveryMode = privateEnv.EMAIL_DELIVERY;
		privateEnv.EMAIL_DELIVERY = 'log';
		const log = vi.spyOn(console, 'info').mockImplementation(() => {});

		try {
			await sendBudgetAlertEmail(
				'admin@example.com',
				'Empresa\r\nBcc: bad@example.com',
				'2026-06',
				[
					{
						categoryName: 'Limpeza <script>',
						usagePct: 85,
						spentLabel: 'R$ 850,00',
						budgetLabel: 'R$ 1.000,00',
						status: 'warning'
					},
					{
						categoryName: 'Sem percentual',
						usagePct: null,
						spentLabel: 'R$ 0,00',
						budgetLabel: 'R$ 0,00',
						status: 'warning'
					}
				]
			);

			expect(log).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					to: 'admin@example.com',
					subject: 'Budget alerts - Empresa Bcc: bad@example.com',
					text: expect.stringContaining('Limpeza <script>: 85%')
				})
			);
			expect(log).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					text: expect.stringContaining('Sem percentual: 0%')
				})
			);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete privateEnv.EMAIL_DELIVERY;
			} else {
				privateEnv.EMAIL_DELIVERY = previousDeliveryMode;
			}
			log.mockRestore();
		}
	});

	it('throws when SMTP is not configured outside log delivery mode', async () => {
		const previous = captureEmailEnv();
		clearEmailEnv();

		try {
			await expect(
				sendMail({ to: 'admin@example.com', subject: 'Teste', text: 'Mensagem' })
			).rejects.toThrow('SMTP is not configured');
		} finally {
			restoreEmailEnv(previous);
		}
	});

	it('sends transactional emails through configured SMTP with and without auth', async () => {
		const previous = captureEmailEnv();
		createTransportMock.mockClear();
		sendMailMock.mockClear();
		sendMailMock.mockResolvedValue(undefined);

		try {
			privateEnv.SMTP_HOST = 'smtp.example.com';
			privateEnv.SMTP_PORT = '465';
			privateEnv.SMTP_SECURE = 'true';
			privateEnv.SMTP_USER = 'smtp-user';
			privateEnv.SMTP_PASSWORD = 'smtp-pass';
			privateEnv.SMTP_FROM = 'no-reply@example.com';
			delete privateEnv.EMAIL_DELIVERY;

			await sendPasswordResetEmail('user@example.com', 'https://app.example/reset?token=abc');
			await sendVerificationEmail('user@example.com', 'https://app.example/verify?token=abc');
			await sendInvitationEmail(
				'new@example.com',
				'Empresa <Financeiro>',
				'https://app.example/invite/abc'
			);

			expect(createTransportMock).toHaveBeenCalledWith({
				host: 'smtp.example.com',
				port: 465,
				secure: true,
				auth: {
					user: 'smtp-user',
					pass: 'smtp-pass'
				}
			});
			expect(sendMailMock).toHaveBeenCalledTimes(3);
			expect(sendMailMock).toHaveBeenCalledWith(
				expect.objectContaining({
					from: 'no-reply@example.com',
					to: 'new@example.com',
					subject: 'Invite to Empresa <Financeiro>'
				})
			);

			privateEnv.SMTP_PORT = '587';
			privateEnv.SMTP_SECURE = 'false';
			delete privateEnv.SMTP_USER;
			delete privateEnv.SMTP_PASSWORD;

			await sendMail({ to: 'admin@example.com', subject: 'Sem auth', text: 'Mensagem' });

			expect(createTransportMock).toHaveBeenLastCalledWith({
				host: 'smtp.example.com',
				port: 587,
				secure: false,
				auth: undefined
			});
		} finally {
			restoreEmailEnv(previous);
		}
	});

	it('localizes transactional email copy when pt-BR is requested', async () => {
		const previousDeliveryMode = privateEnv.EMAIL_DELIVERY;
		privateEnv.EMAIL_DELIVERY = 'log';
		const log = vi.spyOn(console, 'info').mockImplementation(() => {});

		try {
			await sendInvitationEmail(
				'new@example.com',
				'Empresa Financeira',
				'https://app.example/invite/abc',
				'pt-BR'
			);

			expect(log).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					to: 'new@example.com',
					subject: 'Convite para Empresa Financeira',
					text: expect.stringContaining('Você recebeu um convite')
				})
			);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete privateEnv.EMAIL_DELIVERY;
			} else {
				privateEnv.EMAIL_DELIVERY = previousDeliveryMode;
			}
			log.mockRestore();
		}
	});
});

function captureEmailEnv() {
	return {
		EMAIL_DELIVERY: privateEnv.EMAIL_DELIVERY,
		SMTP_HOST: privateEnv.SMTP_HOST,
		SMTP_PORT: privateEnv.SMTP_PORT,
		SMTP_SECURE: privateEnv.SMTP_SECURE,
		SMTP_USER: privateEnv.SMTP_USER,
		SMTP_PASSWORD: privateEnv.SMTP_PASSWORD,
		SMTP_FROM: privateEnv.SMTP_FROM
	};
}

function clearEmailEnv() {
	delete privateEnv.EMAIL_DELIVERY;
	delete privateEnv.SMTP_HOST;
	delete privateEnv.SMTP_PORT;
	delete privateEnv.SMTP_SECURE;
	delete privateEnv.SMTP_USER;
	delete privateEnv.SMTP_PASSWORD;
	delete privateEnv.SMTP_FROM;
}

function restoreEmailEnv(values: ReturnType<typeof captureEmailEnv>) {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete privateEnv[key];
		} else {
			privateEnv[key] = value;
		}
	}
}
