# Security

## Implemented Controls

- Authentication with Better Auth
- Email verification required by default in production
- Secure cookies configured by the auth library
- Persistent rate limiting for login, registration and password reset
- Rate limiting uses the real proxy IP only when `TRUST_PROXY_HEADERS=true`
- Isolation by `workspace_id` in all domain services
- Workspace-scoped RBAC
- Financial values stored in cents
- Invitations with hashed tokens
- Optional per-user MFA/TOTP with encrypted secret, hashed recovery codes and a global gate for authenticated sessions
- Attachments with size limit, MIME allowlist, authenticated download and blocking when the expense was removed
- Attachment upload and download through streaming to avoid large buffers in the Node process
- Soft delete for expenses
- Audit trail for main actions with filters by action and entity
- Request ID and `Server-Timing` in HTTP responses
- Security headers in the global hook and Caddy
- CSP in production
- Production compose with the app on a read-only filesystem, `tmpfs` for temporary files, dropped capabilities, `no-new-privileges`, resource limits and application healthcheck

## Pre-Production Checklist

- `BETTER_AUTH_SECRET` generated with high entropy
- SMTP tested
- `REQUIRE_EMAIL_VERIFICATION=true` in production unless an operational exception is documented
- HTTPS active
- `TRUST_PROXY_HEADERS=true` only if the app is isolated behind a trusted reverse proxy
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
