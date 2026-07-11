# Plan 013: Reconcile OFX transactions against existing expenses

> **Executor instructions**: Matching suggestions must never mutate financial state until an authorized user confirms them. Follow the existing payment state machine and Svelte conventions.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/imports.ts src/lib/server/services/expenses.ts src/lib/server/db/schema.ts src/routes/'(protected)'/app/planning src/routes/'(protected)'/app/expenses src/lib/i18n/messages.ts drizzle`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/005-bound-money-values.md, plans/006-atomic-audit-events.md, plans/012-import-preview-undo.md
- **Category**: direction, feature
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

OFX support currently creates expenses, while the product separately tracks unpaid, paid and reconciled states. Users need to match bank transactions to existing expenses before creating unmatched entries, avoiding duplicates and making reconciliation meaningful.

## Current state

- `src/lib/server/utils/import.ts:101-143`: parses OFX transactions into imported expense rows.
- `src/lib/server/services/expenses.ts:521-591`: enforces payment state transitions and reconciliation metadata.
- `src/lib/server/services/imports.ts`: treats OFX like CSV creation.
- `src/lib/server/db/schema.ts:537-540`: stores payment status, paid date and reconciler.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, targeted reconciliation/import/expense tests, the Svelte autofixer, reconciliation E2E and visual suites, then `pnpm verify`; every command must exit 0.

## Scope

**In scope**:

- staged OFX transaction model and forward migration
- deterministic candidate matching by workspace, amount/date and normalized text
- confirmation service for match, ignore or create-new decisions
- reconciliation UI, audit events, translations, tests and docs

**Out of scope**:

- direct bank APIs, credential storage or automatic background bank sync
- probabilistic/AI matching
- automatically reconciling without user confirmation

## Git workflow

- Branch: `feat/013-ofx-reconciliation`
- One commit: `feat(reconciliation): match OFX transactions to expenses`

## Steps

### 1. Persist idempotent staged bank transactions

Model source account/file fingerprint, provider transaction ID where present, date, signed amount, description, status and chosen expense. Create a workspace-scoped uniqueness constraint. Preserve raw OFX only if required; otherwise store normalized fields and checksum to minimize financial data retention.

**Verify**: migration and integration tests prove re-upload is idempotent and cross-workspace access is denied.

### 2. Generate conservative match candidates

Candidate generation must be deterministic and explainable: exact amount, configurable small date window, eligible non-reconciled expense, then text similarity as ordering only. Return the reasons/scores; never auto-confirm. Ensure one expense cannot be confirmed against two transactions under concurrency.

**Verify**: table-driven tests cover exact match, ambiguity, no match, already reconciled, concurrent confirmation and locale-independent normalization.

### 3. Apply confirmed decisions atomically

Match confirmation updates payment state/reconciler and staged transaction plus audit in one transaction. Create-new delegates to the existing import creation path. Ignore records the decision without deleting source history.

**Verify**: rollback tests prove no half-reconciled states.

### 4. Build the reconciliation workspace

Use a two-pane ledger on wide screens and stacked cards on mobile: bank transaction on one side, proposed expense on the other, with amount/date alignment as the visual signature. Reuse status pills, buttons, searchable selects and dialogs. Use `$derived` for filtered queues and keyed each blocks; respect reduced motion and minimum target sizes. All strings use `t()`.

Run the Svelte autofixer on every changed component.

**Verify**: E2E covers match, ambiguous choice, create new, ignore, unauthorized role, keyboard flow and mobile layout; add visual snapshots.

### 5. Run all gates

**Verify**: migrations twice and `pnpm verify` pass.

## Test plan

- Parser/staging tests cover stable IDs/checksums, re-upload and credit handling.
- Candidate table tests cover exact, ambiguous, absent and already-reconciled matches.
- Transaction tests cover one-to-one concurrency, atomic match/create/ignore and RBAC.
- E2E/visual/accessibility tests cover the complete desktop/mobile decision queue.

## Done criteria

- [ ] Re-uploaded OFX transactions do not duplicate staged or expense records.
- [ ] No reconciliation occurs without authorized confirmation.
- [ ] State/audit changes are atomic and concurrency-safe.
- [ ] Matching reasons are visible and deterministic.
- [ ] Full verify passes.

## STOP conditions

- OFX fixtures lack any stable transaction identifier and checksum design cannot prevent accidental collisions.
- Product policy for positive/credit transactions is ambiguous; stop with examples rather than guessing.
- Matching would require fuzzy logic that cannot be explained to the user.

## Maintenance notes

Keep matching deterministic. Future bank integrations should feed the same staged-transaction contract rather than bypassing confirmation.
