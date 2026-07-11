# Security

## Implemented Controls

- Authentication with Better Auth
- Email verification required by default in production
- Secure cookies configured by the auth library
- Persistent rate limiting for login, registration and password reset
- Rate limiting uses forwarded client addresses only when `TRUST_PROXY_HEADERS=true` and the immediate peer matches `TRUSTED_PROXY_CIDR`
- Isolation by `workspace_id` in all domain services
- Workspace-scoped RBAC
- Financial values stored in cents, with each persisted amount capped at 100,000,000,000 cents
  so PostgreSQL `bigint` values remain exact when mapped to JavaScript numbers
- Invitations with hashed tokens
- Optional per-user MFA/TOTP with encrypted secret, hashed recovery codes and a global gate for authenticated sessions
- Attachments with size limit, MIME allowlist, authenticated download and blocking when the expense was removed
- Attachment upload and download through streaming to avoid large buffers in the Node process
- Soft delete for expenses
- Audit trail for main actions with filters by action and entity
- Request ID and `Server-Timing` in HTTP responses
- Security headers in the global hook and Caddy
- CSP in production
- Build SBOM/provenance metadata and GitHub artifact attestations for published container images
- Dependabot version-update coverage for npm packages, GitHub Actions and Docker base images
- Production compose with the app on a read-only filesystem, `tmpfs` for temporary files, dropped capabilities, `no-new-privileges`, resource limits and application healthcheck
- Production compose mounts required app/database/backup secrets through Docker Compose secrets instead of direct service environment values

## Pre-Production Checklist

- `BETTER_AUTH_SECRET` generated with high entropy
- Mailjet email delivery tested with the production provider. See
  [`docs/email.md`](email.md) for the setup.
- `REQUIRE_EMAIL_VERIFICATION=true` in production unless an operational exception is documented
- `ALLOW_REGISTRATION=false` when production access should be invite-only or manually managed
- HTTPS active
- `TRUST_PROXY_HEADERS=true` only if the app is isolated behind a trusted reverse proxy, with `TRUSTED_PROXY_CIDR` set to the narrowest deployment-specific proxy subnet; no broad private-network CIDR is trusted by default
- Backups copied outside the VPS
- Restore tested
- `uploads` volume backup checked and copied outside the VPS when receipts are used
- `pnpm audit --prod` reviewed
- `pnpm verify` passing
- `docker compose config` valid for the production `.env`
- `scripts/postgres-observability.sql` diagnostics reviewed after real traffic exists
- VPS SSH access limited to keys
- Firewall allowing only SSH, 80 and 443

## Audit Exceptions

`pnpm-workspace.yaml` ignores two known production audit advisories:

- `GHSA-67mh-4wv8-2f99`: `esbuild` below `0.24.3` appears through peer/tooling dependencies of `drizzle-kit`, used for migrations/build and not by the final Node server.
- `GHSA-pxg6-pf52-xh8x`: `cookie@0.6.0` appears through `@sveltejs/kit`. The reported risk is low and should disappear when SvelteKit updates the dependency.

Reevaluate these exceptions after each dependency update.

## Permission Model

- `owner`: manages workspace, users, categories and expenses
- `admin`: manages users, categories and expenses
- `member`: creates and edits expenses
- `viewer`: read-only access

## ASVS-Oriented Review Checklist

Use [`threat-model.md`](threat-model.md) as the lightweight system threat model
and update it whenever trust boundaries, auth, deployment, backup or monitoring
controls change.

Use this checklist before production releases and after meaningful auth, billing,
file, report or deployment changes:

- Authentication: login, logout, password reset, email verification, invite
  acceptance and registration lock-down have success and failure tests.
- Session security: cookies are secure in production, trusted proxy headers are
  enabled only behind the reverse proxy and CSRF-sensitive mutations are
  protected by server-side authorization checks.
- Authorization: every workspace query is scoped by `workspace_id`, and every
  role has route-level and action-level tests for allowed and denied behavior.
- Input validation: IDs, dates, amounts, pagination, uploaded files and enum-like
  fields reject malformed or cross-workspace values.
- Rate limiting: login, registration, password reset and verification email
  resend limits are persistent and tested for abuse cases.
- Email delivery: provider credentials live only in protected secrets or VPS
  secret files, sender domains are verified and failed delivery does not create
  silent account states.
- Data protection: passwords, invite tokens, verification tokens, recovery
  codes and MFA secrets are hashed or encrypted according to their use.
- File handling: upload size, MIME allowlist, authenticated download,
  cross-workspace denial and deleted-expense denial are tested.
- Observability: request IDs, audit logs, health checks, synthetic checks,
  Alertmanager notifications, alert fire drills, post-reboot health checks,
  recovery drills, DNS/TLS probes, Traefik checks and private dashboards are
  active without logging passwords, tokens, emails, request bodies or financial
  details.
- Log retention: Loki has a short retention window, Docker logs are size-capped
  for managed compose services and log collectors do not expose ingestion
  endpoints publicly.
- Deployment: the app runs non-root with a read-only filesystem where possible,
  Docker management UIs stay private to the tailnet and rollback is tested.
- Backup and restore: remote backups are encrypted, restore is tested in a
  separate environment and local pre-deploy dumps are treated only as rollback
  aids.
- NAS backup: SFTP keys are dedicated to backup, restic encryption is enabled,
  the restic password is stored outside the repository and restore is tested
  without exposing raw dumps.
- Monitoring backup: Grafana/Uptime Kuma/Dockge state and monitoring
  configuration are backed up separately from application data, with Prometheus
  and Loki time-series/log chunks excluded from the lightweight backup.
- Restic checks: encrypted backup repositories have periodic structural checks
  in addition to restore tests, and both emit alertable metrics.
- Tailnet access: Tailscale ACLs restrict management UIs, NAS backup SSH/SFTP,
  NAS metrics and Loki ingestion to the minimum devices and tags required.
- Dependency security: `pnpm audit --prod`, Dependabot PRs, container image
  updates, image SBOM/provenance attestations and known audit exceptions are
  reviewed before each release.
