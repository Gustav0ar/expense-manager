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
MAILJET_WEBHOOK_USERNAME="<dedicated-random-username>"
MAILJET_WEBHOOK_PASSWORD="<dedicated-random-password>"
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

## Durable Invitation Delivery

Invitation creation commits the invitation and its delivery record in one
database transaction before contacting the provider. The acceptance token stays
hashed on the invitation. The delivery record contains only an AES-256-GCM
ciphertext, a versioned HKDF derivation context, delivery status, a short-lived
claim, bounded attempt count, provider identifiers and a coarse error category.
It never stores or logs the plaintext token or provider error body.

The first delivery attempt happens after commit. Provider rejection, network
failure or an accepted-but-timed-out request leaves the same link retryable;
automatic retries never rotate or invalidate it. Claims expire after ten minutes,
are ownership-checked on completion and are selected with `FOR UPDATE SKIP
LOCKED`. A session advisory lock limits each background cycle to one application
instance, while the row claim also prevents races with immediate delivery. Each
cycle claims at most 25 rows and each delivery is attempted at most eight times.
The `/api/health` background-job payload exposes scheduler attempts, cumulative
failed deliveries and the latest failed count.

Submitting the normal invite form again for an existing pending address preserves
its original link and role. The explicit **Resend** action is the only operation
that rotates that invitation token, refreshes its expiry and records a resend
audit event. Invitations created before the delivery ledger have no recoverable
plaintext token; they remain valid, show as legacy in the UI and must be
explicitly resent to enter durable delivery.

Invitation encryption derives a dedicated key from `BETTER_AUTH_SECRET`; it does
not reuse that secret as an AES key. Ciphertexts include a derivation-format
version. The application reads retained rotation keys from
`BETTER_AUTH_SECRET_PREVIOUS_FILE` first, with the direct
`BETTER_AUTH_SECRET_PREVIOUS` value available for non-Compose runtimes. Multiple
retained keys are comma-separated.

### Application-secret rotation

Never replace the current application secret until its old value is available to
the new container as the previous secret. Authenticated ciphertext intentionally
cannot be decrypted with an unrelated key.

For the GitHub deployment workflow:

1. Set the protected `BETTER_AUTH_SECRET_PREVIOUS` production secret to the exact
   old/current value. Do not print or copy it into workflow input or logs.
2. Replace the protected `BETTER_AUTH_SECRET` production secret with the newly
   generated value and run the normal reviewed deployment. The deploy script
   writes both values to separate mode-`0444` Compose secret files before it
   recreates the application container.
3. Confirm a queued invitation created before rotation can still be delivered and
   accepted. Monitor `invitationDeliveryScheduler` in `/api/health`.
4. Wait at least the seven-day invitation lifetime, or explicitly resend every
   remaining pending invitation so it is encrypted with the new key.
5. Delete the `BETTER_AUTH_SECRET_PREVIOUS` production secret and deploy again.
   The deploy script replaces the retained-key file with an empty file; the app
   then uses only the current key.

For direct Docker Compose, copy the current secret file to a separate private
file before replacing it, set
`BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE=./secrets/better_auth_secret_previous`
in the private `.env`, and recreate `app`. These commands keep secret material
out of terminal output:

```bash
umask 077
mkdir -p secrets
chmod 700 secrets
install -m 0444 secrets/better_auth_secret secrets/better_auth_secret_previous
openssl rand -base64 48 > secrets/better_auth_secret.next
chmod 0444 secrets/better_auth_secret.next
mv secrets/better_auth_secret.next secrets/better_auth_secret
# Set BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE in the private .env, then:
docker compose up -d --force-recreate app
```

After the overlap, set the source back to `/dev/null`, recreate `app`, and only
then remove the retained file:

```bash
# Set BETTER_AUTH_SECRET_PREVIOUS_SOURCE_FILE=/dev/null in the private .env, then:
docker compose up -d --force-recreate app
rm -f secrets/better_auth_secret_previous
```

Both shipped Compose files default the optional previous secret to `/dev/null`,
so deployments that are not rotating require no additional file. The full
production procedure is also documented in [`DEPLOY.md`](../DEPLOY.md).

## Mailjet Delivery Feedback

The application accepts Mailjet Event API callbacks at:

```text
https://<username>:<password>@your-domain.example/api/webhooks/mailjet
```

Set `MAILJET_WEBHOOK_USERNAME` and `MAILJET_WEBHOOK_PASSWORD` to the same
dedicated Basic Auth credential, then configure that HTTPS URL in Mailjet's
Event Tracking settings. Generate URL-safe random values, do not reuse the
Mailjet API secret, and enable grouped events (Event API version 2) to reduce
callback volume.

The endpoint accepts Mailjet's `sent`, `open`, `click`, `bounce`, `spam`,
`blocked` and `unsub` events. It has a 256 KiB body limit, accepts at most 100
grouped events, rejects timestamps outside a 48-hour replay window and stores a
unique SHA-256 fingerprint for idempotency. Mailjet retries therefore return
HTTP 200 without duplicating data.

Budget-alert messages include an opaque per-recipient `CustomID`. Callbacks are
matched using that value plus the normalized recipient address, and the ledger
records the latest provider event in event-time order. The event table stores
only the provider, event type, timestamps and provider identifiers; it does not
persist callback IP addresses, user agents, clicked URLs, raw payloads or email
addresses. A daily background job removes event rows after 90 days.

If the webhook credential is absent, sending continues normally and the
callback endpoint returns HTTP 503. This keeps the feedback integration
optional for existing deployments while making a missing callback setup
visible to Mailjet.

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
- Retain the previous application secret only for the bounded invitation-key
  rotation window described above, then remove it.
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
6. Configure the authenticated Event API callback and enable grouped events.
7. Trigger a budget alert and confirm its ledger receives a `sent` event.
8. Check Mailjet logs and confirm the messages are delivered.
9. Confirm SPF, DKIM and DMARC pass in the received email headers.

## References

- Mailjet Send API v3.1:
  https://dev.mailjet.com/email/guides/send-api-v31/
- Mailjet Event API:
  https://dev.mailjet.com/email/guides/webhooks/
