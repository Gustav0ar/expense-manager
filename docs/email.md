# Email Delivery

This application sends transactional email for password reset, email
verification, workspace invitations and budget alerts. Production should use a
dedicated SMTP provider instead of a mail server on the VPS.

## Recommended Provider: Sender

Use Sender through SMTP. The application already supports SMTP through
Nodemailer, so no code change is required.

Sender setup:

1. Create or open a Sender account.
2. Add the sending domain in `Account settings -> Domains`.
3. Add every DNS record Sender provides for ownership, SPF, DKIM and DMARC.
4. Wait until Sender marks the domain as verified.
5. Open `Transactional emails -> Setup instructions -> SMTP`.
6. Create a dedicated SMTP user for this app, for example
   `expense-manager-production`.
7. Copy the generated password immediately and store it only in the production
   secret store.

Production environment values:

```env
EMAIL_DELIVERY=""
SMTP_HOST="smtp.sender.net"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="<sender-smtp-username>"
SMTP_PASSWORD="<sender-smtp-password>"
SMTP_FROM="Expense Manager <no-reply@your-verified-domain.example>"
REQUIRE_EMAIL_VERIFICATION="true"
```

Use port `587` with STARTTLS first. If the VPS network blocks it, use port
`2525`. Keep `SMTP_SECURE="false"` for both because Nodemailer starts the
connection normally and upgrades it with STARTTLS when the server supports it.

The `SMTP_FROM` domain must match a verified Sender domain. Do not use a
personal mailbox as the production sender.

## Secret Handling

- Never commit SMTP credentials.
- Keep SMTP credentials only in the VPS `.env`, GitHub Actions secrets or a
  private secret manager.
- Use a dedicated SMTP user for production.
- Use a separate SMTP user for staging if staging sends real email.
- Rotate the SMTP password immediately if it is copied into a chat, log, shell
  history, issue, pull request or commit.
- Do not enable `EMAIL_DELIVERY="log"` in production because it writes email
  subjects and bodies to logs.

## DNS Policy

Sender provides exact DNS values per account/domain. Use those exact records.
At minimum, production should have:

- SPF authorizing Sender for the sending domain.
- DKIM enabled and passing.
- DMARC published for the sending domain.

Start DMARC in monitoring mode while testing:

```txt
v=DMARC1; p=none; rua=mailto:dmarc@your-domain.example
```

After real delivery is confirmed, move toward a stricter policy such as
`quarantine` or `reject`.

## Deployment Checklist

1. Set the SMTP variables in the private production `.env`.
2. Set `ORIGIN` to the public HTTPS origin of the app.
3. Set `REQUIRE_EMAIL_VERIFICATION="true"` in production unless there is a
   documented exception.
4. Restart the app container.
5. Trigger each transactional flow:
   - registration verification;
   - password reset;
   - workspace invitation;
   - budget alert.
6. Check `Transactional emails -> Logs` in Sender and confirm the messages are
   delivered.
7. Confirm SPF, DKIM and DMARC pass in the received email headers.

## References

- Sender transactional email setup:
  https://www.sender.net/help/transactional-emails/setting-up-transactional-emails/
- Sender SMTP setup:
  https://www.sender.net/help/transactional-emails/getting-started/
- Sender sender identity and domain requirements:
  https://www.sender.net/help/transactional-emails/sender-identity-and-domain-requirements/
