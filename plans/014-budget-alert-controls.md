# Plan 014: Expose budget-alert history, recipients and escalation controls

> **Executor instructions**: Reuse the existing delivery ledger and provider feedback. Do not expose provider identifiers or recipient data to unauthorized workspaces.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/budgets.ts src/lib/server/services/email-delivery-events.ts src/lib/server/db/schema.ts src/routes/'(protected)'/app/planning src/lib/i18n/messages.ts drizzle docs/email.md`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-enforce-i18n.md, plans/006-atomic-audit-events.md, plans/009-durable-invitation-delivery.md
- **Category**: direction, feature
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

The backend tracks recipient-level budget deliveries and Mailjet events, but the UI only offers a workspace-wide enable switch and manual send. Administrators cannot see failures/bounces, choose recipients or request escalation when a warning becomes over-budget.

## Current state

- `src/routes/(protected)/app/planning/+page.svelte:84-118`: enable/disable and send-now controls only.
- `src/lib/server/db/schema.ts:256-329`: delivery ledger has recipient, status, attempts and provider feedback.
- `src/lib/server/services/budgets.ts:376-417`: sends warning/over items to every active owner/admin.
- `src/lib/server/services/email-delivery-events.ts:175-213`: records latest provider event.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, budget/email-delivery/background-job tests, the Svelte autofixer, planning E2E plus visual tests, and `pnpm verify`; all must exit 0.

## Scope

**In scope**:

- workspace alert thresholds/escalation policy and recipient preferences
- delivery-history query and authorized UI
- retry/resend rules, provider-event presentation, translations, tests and docs
- forward migrations as required

**Out of scope**:

- adding a new email provider
- exposing full webhook payloads/provider secrets
- per-expense notifications

## Git workflow

- Branch: `feat/014-budget-alert-controls`
- One commit: `feat(budgets): add alert controls and delivery history`

## Steps

### 1. Specify escalation and recipient semantics

Support explicit workspace recipients chosen from active owner/admin members and at least warning/over transitions. Define whether a recipient may receive one warning and one over-budget escalation per category/month. Encode the dedup key in the database, not only application logic. Preserve current boolean preference as the default migration behavior.

**Verify**: table-driven service tests cover threshold crossing, repeated hourly runs, recipient changes, failure retry and warning-to-over escalation.

### 2. Add scoped history services

Return human-facing status, attempt count, timestamps and last provider event without raw provider IDs. Enforce `canManageBudgets` in the service. Paginate history.

**Verify**: RBAC and cross-workspace tests pass for owner/admin/member/viewer.

### 3. Build a budget notification center

Keep the existing budgeting visual language. Use a threshold rail tied to category budget percentages as the signature element; delivery history remains a quiet, paginated ledger. Use plain labels such as “Warning sent,” “Delivery failed,” and “Over-budget alert.” Reuse dialogs/status pills, keyed each blocks and `$derived`; avoid effects for form state. All text goes through `t()`.

Run the Svelte autofixer on every changed component.

**Verify**: planning E2E covers preferences, escalation, history, retry, RBAC, empty state, mobile and keyboard usage; visual snapshots pass.

### 4. Run all gates

**Verify**: migrations twice, Mailjet webhook tests and `pnpm verify` pass.

## Test plan

- Scheduler tests cover warning/over transitions, repeated runs, recipient changes and delivery retry.
- History service tests cover pagination, cross-workspace isolation and RBAC.
- Webhook feedback tests confirm bounce/block/open labels without exposing identifiers.
- E2E/visual/accessibility tests cover controls, history, empty/failure states and mobile layout.

## Done criteria

- [ ] Recipient and escalation rules are explicit and DB-idempotent.
- [ ] Administrators can understand and retry delivery failures.
- [ ] Provider-sensitive identifiers are not rendered.
- [ ] Existing opt-in workspaces retain expected behavior.
- [ ] Full verify passes.

## STOP conditions

- The product decision on per-category versus per-workspace escalation cannot be inferred; present both schemas and stop.
- A schema change would resend historical alerts after deployment.
- Recipient controls would allow non-admin addresses without a verified-user policy.

## Maintenance notes

Provider events are advisory feedback, not proof that a user read an alert. Keep UI wording precise.
