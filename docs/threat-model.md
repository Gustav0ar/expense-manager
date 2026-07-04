# Threat Model

This document is intentionally generic and safe for a public repository. Keep
real hostnames, IP addresses, user emails, tokens, backup repository URLs and
provider account details in private operational notes.

## Scope

In scope:

- Expense Manager web application.
- Postgres database and uploaded receipts.
- Authentication, registration, invitations, password reset and MFA.
- GitHub Actions deployment to a private VPS.
- Traefik public ingress.
- Private monitoring stack on the tailnet.
- NAS-based encrypted restic backups.
- Operational access through SSH, Tailscale, Grafana, Dozzle and Dockge.

Out of scope:

- DNS provider implementation details.
- Email provider internal security.
- Physical security of the VPS provider and NAS location.
- User endpoint device compromise.

## Primary Assets

- User credentials and sessions.
- Workspace membership and role assignments.
- Expense data, attachments and reports.
- Email verification, password reset and invitation tokens.
- MFA secrets and recovery codes.
- Database encryption/backup credentials.
- Deployment SSH keys and GitHub environment secrets.
- Monitoring credentials and Telegram notification secrets.
- Restic repository passwords and NAS SSH keys.

## Trust Boundaries

- Browser to public Traefik endpoint.
- Traefik to application container over a private Docker network.
- Application container to Postgres over a private Docker network.
- GitHub Actions to VPS over SSH, optionally through Tailscale.
- VPS to NAS over Tailscale and restricted SSH/SFTP.
- NAS log collectors/exporters to VPS monitoring endpoints over Tailscale.
- Operators to private management UIs over Tailscale.
- Application to external email provider over HTTPS/SMTP.

## Threat Actors

- Internet attacker without credentials.
- Authenticated user attempting cross-workspace access.
- Invited user with lower role attempting privileged actions.
- Attacker with leaked email provider or GitHub secret.
- Attacker on the tailnet with insufficient authorization.
- Malware or compromised browser extension on an operator device.
- Operational mistake during deployment, restore or container management.

## Key Threats And Controls

| Threat                                   | Primary controls                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credential stuffing or brute-force login | Persistent rate limiting, secure password handling, optional MFA, audit logs                   |
| Unverified or abusive registration       | Email verification, registration lock-down, resend limits, stale unverified-user cleanup       |
| Cross-workspace data access              | Workspace-scoped service queries, RBAC, route/action tests                                     |
| Privilege escalation through invites     | Role-specific invite handling, authorization checks, role E2E coverage                         |
| Token leakage                            | Hashed invite/reset/verification tokens, short token lifetime, secret redaction in docs        |
| Attachment abuse                         | Size limit, MIME allowlist, authenticated download, deleted-expense download block             |
| Sensitive log exposure                   | No request body logging, no password/token/email/financial value logging, short Loki retention |
| Public exposure of management tools      | Tailscale-only binding, no public Traefik routes, ACL tests                                    |
| Broken deploy                            | Pre-deploy dump, automatic image rollback, post-deploy smoke checks                            |
| Database loss or corruption              | Encrypted off-VPS restic backups, restore tests, checksums, disaster recovery runbook          |
| Backup repository corruption             | Periodic restic structural checks and restore-test timers                                      |
| Silent monitoring failure                | Alertmanager fire drill, post-reboot healthcheck, stale metric alerts                          |
| DNS/TLS/Traefik failure                  | Blackbox DNS/TLS probes, Traefik container alerts                                              |
| NAS outage                               | App remains self-contained on VPS, backup stale alerts, retryable backup service               |
| Compromised Docker management UI         | Tailscale-only access, strong generated credentials, limited exposure, operational audit       |

## Residual Risks

- A compromised administrator device can still access private UIs and SSH.
- A compromised GitHub production environment secret can deploy malicious code.
- A lost restic password makes encrypted backups unrecoverable.
- If both VPS and NAS are lost before backups are copied elsewhere, recovery is
  limited to any separate private copies of secrets and snapshots.
- Email delivery depends on the provider accepting the sender domain and API
  credentials.

## Required Review Triggers

Review this model when any of these changes:

- Authentication, MFA, session or role code.
- Registration, invite or password reset flow.
- Attachment storage or report export behavior.
- Deployment workflow or GitHub secret model.
- Backup repository, NAS access or restic password handling.
- Tailscale ACLs or private management ports.
- Monitoring/alerting architecture.
- Public ingress, Traefik labels or DNS provider.

## Verification Checklist

- `pnpm verify` passes before production releases.
- Role E2E tests cover allowed and denied access.
- `pnpm test:prometheus-rules` passes after alert rule changes.
- Production smoke test passes after deployment.
- Operational audit script passes after infrastructure changes.
- Application and monitoring backup restore tests are recent.
- Restic structural checks are recent.
- Tailscale ACL tests pass before policy changes are applied.
- No production secrets, domains or IPs are committed.
