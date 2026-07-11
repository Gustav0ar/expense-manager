# Plan 009: Make invitation delivery durable and retry-safe

> **Executor instructions**: Keep bearer tokens hashed at rest and preserve registration-lockdown invite behavior. Run all commands inside the dev container.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/workspaces.ts src/lib/server/services/invitations.ts src/lib/server/email.ts src/lib/server/db/schema.ts drizzle src/routes/'(protected)'/app/settings/users docs/email.md`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/001-repair-migration-ledger.md, plans/003-expand-coverage-scope.md, plans/006-atomic-audit-events.md
- **Category**: bug, architecture
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Invitation state commits before email delivery. A provider timeout can mean the email was accepted while the action fails; retrying rotates the token and invalidates the first delivered link. Delivery needs a durable state machine and explicit resend semantics.

## Current state

- `src/lib/server/services/workspaces.ts:230-267`: creates a token and rotates its hash on pending-email conflict.
- `workspaces.ts:284-289`: sends after the transaction and propagates failure.
- `src/lib/server/db/schema.ts:80-110`: invitation stores only hashed token, status and expiry.
- Budget-alert delivery in `src/lib/server/services/budgets.ts:419-551` is the repository's claim/status/retry exemplar.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, targeted invitation/background-job integration tests, `pnpm exec playwright test src/routes/users.e2e.ts src/routes/roles.e2e.ts --timeout=60000`, the Svelte autofixer for changed components, and `pnpm verify`; all must succeed.

## Scope

**In scope**:

- invitation delivery ledger/outbox schema and forward migration
- invitation create/resend services and background delivery job
- users settings delivery status/resend UI
- audit events, health state, email docs, unit/integration/E2E tests

**Out of scope**:

- generic password-reset/verification outbox
- storing plaintext invite tokens in PostgreSQL
- changing invite expiry or role rules without explicit documentation

## Git workflow

- Branch: `feat/009-invitation-outbox`
- One commit: `feat(invitations): add durable email delivery`

## Steps

### 1. Design a hashed-token-compatible outbox

Add delivery state (`pending`, `sending`, `sent`, `failed`), claim token/expiry, attempts and last error category without storing secrets. Because the email needs the raw bearer token, choose a safe design: encrypt the short-lived token with the existing application secret and authenticated encryption, or generate/send synchronously once while making retries explicit with a newly generated token. Document the threat tradeoff. Never store plaintext.

**Verify**: migration tests and encryption/token-redaction tests pass.

### 2. Separate create from explicit resend

Creating an already-pending invitation must not silently rotate a possibly delivered token. Add a deliberate resend action that rotates only when requested and records an audit event. Return a truthful partial-success state if persistence succeeded but immediate delivery did not.

**Verify**: integration tests simulate success, provider failure, accepted-then-timeout, concurrent claims and explicit resend.

### 3. Add background retry and UI status

Add a bounded advisory-locked job with claim expiry, health reporting and retry limits. Show delivery status and a localized resend button to authorized managers. Follow Svelte 5 runes, keyed lists and event conventions; run `npx @sveltejs/mcp svelte-autofixer` on changed components.

**Verify**: users E2E covers failure, retry, stable original link and explicit invalidation on resend.

### 4. Run all gates

**Verify**: migrations twice, `pnpm verify`, and email docs checks pass.

## Test plan

- Delivery service tests: success, provider failure, timeout uncertainty, retry claim expiry and concurrency.
- Token tests: stable on automatic retry, rotated only on explicit resend, never persisted/logged plaintext.
- RBAC tests: owner/admin allowed; member/viewer denied for resend/status mutation.
- Users/roles E2E and mobile/desktop UI checks pass.

## Done criteria

- [ ] Provider uncertainty cannot silently invalidate a delivered link.
- [ ] No plaintext invite token is stored or logged.
- [ ] Claims/retries are multi-instance safe.
- [ ] UI communicates delivery state and explicit resend.
- [ ] Full verify passes.

## STOP conditions

- The design requires plaintext token storage.
- Existing secret configuration cannot provide authenticated encryption without key-rotation planning.
- Better Auth/registration lockdown behavior changes unexpectedly.

## Maintenance notes

Monitor attempt counts and failed deliveries. If a generic transactional email outbox is later introduced, migrate invitation delivery into it without weakening hashed-token storage.
