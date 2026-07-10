# Email Delivery

This application sends transactional email for password reset, email
verification, workspace invitations and budget alerts. Production should use a
dedicated provider instead of a mail server on the VPS.

## Recommended Provider: Mailjet

Use Mailjet through Send API v3.1 in production. SMTP and the legacy Sender
integration remain available as fallback options.

Mailjet setup:

1. Create or open a Mailjet account.
2. Add and verify the sending domain in Mailjet.
3. Add every DNS record Mailjet provides for SPF, DKIM and DMARC.
4. Wait until Mailjet marks the domain as verified.
5. Create a dedicated API key pair for this app, for example
   `expense-manager-production`.
6. Store the API key and secret key only in the production secret store.

Production environment values:

```env
EMAIL_PROVIDER="mailjet"
MAILJET_API_KEY="<mailjet-api-key>"
MAILJET_SECRET_KEY="<mailjet-secret-key>"
MAILJET_FROM="Expense Manager <no-reply@your-verified-domain.example>"
REQUIRE_EMAIL_VERIFICATION="true"
```

The `MAILJET_FROM` domain must match a verified Mailjet domain. Do not use a
personal mailbox as the production sender.

Budget-alert delivery is tracked per workspace, month and recipient. Successful
recipients are not sent the same monthly alert again, while failed recipients
remain retryable. In-flight claims expire after ten minutes so an interrupted
application process cannot leave delivery permanently stuck.

Automatic budget alerts are opt-in per workspace. Owners and administrators can
enable them from the Budget page; the preference stores the selected UI locale.
The background coordinator checks enabled workspaces hourly and uses a Postgres
advisory lock so only one application instance performs a cycle. The existing
monthly recipient ledger makes repeated cycles idempotent and retries failed
recipients without resending successful deliveries. Manual **Send alerts now**
remains available independently of the automatic preference.

SMTP fallback values, if API delivery cannot be used:

```env
EMAIL_PROVIDER="smtp"
SMTP_HOST="in-v3.mailjet.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="<mailjet-api-key>"
SMTP_PASSWORD="<mailjet-secret-key>"
SMTP_FROM="Expense Manager <no-reply@your-verified-domain.example>"
```

Use port `587` with STARTTLS first. If the VPS network blocks it, use port
`2525`. Keep `SMTP_SECURE="false"` for both because Nodemailer starts the
connection normally and upgrades it with STARTTLS when the server supports it.

## Secret Handling

- Never commit Mailjet API keys, secret keys or SMTP credentials.
- Keep email credentials only in the VPS `.env`, GitHub Actions secrets or a
  private secret manager.
- Use a dedicated Mailjet API key pair for production.
- Use a separate Mailjet API key pair for staging if staging sends real email.
- Rotate the secret key immediately if it is copied into a chat, log, shell history,
  issue, pull request or commit.
- Do not enable `EMAIL_DELIVERY="log"` in production because it writes email
  subjects and bodies to logs.

## DNS Policy

Mailjet provides exact DNS values per account/domain. Use those exact records.
At minimum, production should have:

- SPF authorizing Mailjet for the sending domain.
- DKIM enabled and passing.
- DMARC published for the sending domain.

Start DMARC in monitoring mode while testing:

```txt
v=DMARC1; p=none; rua=mailto:dmarc@your-domain.example
```

After real delivery is confirmed, move toward a stricter policy such as
`quarantine` or `reject`.

## Deployment Checklist

1. Set `EMAIL_PROVIDER="mailjet"` and the Mailjet variables in the private production `.env`.
2. Set `ORIGIN` to the public HTTPS origin of the app.
3. Set `REQUIRE_EMAIL_VERIFICATION="true"` in production unless there is a
   documented exception.
4. Restart the app container.
5. Trigger each transactional flow:
   - registration verification;
   - password reset;
   - workspace invitation;
   - budget alert.
6. Check Mailjet logs and confirm the messages are
   delivered.
7. Confirm SPF, DKIM and DMARC pass in the received email headers.

Mailjet's Event API can be added later for real-time delivery, bounce, spam and
open/click notifications. It is not required for sending verification emails.

## References

- Mailjet Send API v3.1:
  https://dev.mailjet.com/email/guides/send-api-v31/
- Mailjet Event API:
  https://dev.mailjet.com/email/guides/#event-api-real-time-notifications
