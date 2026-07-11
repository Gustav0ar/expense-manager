# Plan 015: Add a time-limited recoverable expense trash

> **Executor instructions**: Do not restore an expense into an invalid category/catalog/payment state. This plan must follow the durable attachment lifecycle plan.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/expenses.ts src/lib/server/services/attachments.ts src/lib/server/db/schema.ts src/routes/'(protected)'/app/expenses src/lib/i18n/messages.ts drizzle docs`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/006-atomic-audit-events.md, plans/010-attachment-lifecycle.md
- **Category**: direction, feature
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Expenses are already soft-deleted, but there is no restore surface and attachments are currently removed immediately. Once attachment deletion is delayed and durable, a bounded trash window can protect users from accidental deletion without weakening audit history.

## Current state

- `src/lib/server/services/expenses.ts:621-642`: deletion sets `deleted_at`.
- `expenses.ts:644-678`: attachments are removed as part of deletion.
- All list/report conditions exclude `deleted_at` rows.
- `src/routes/(protected)/app/expenses/DeleteExpenseDialog.svelte`: existing confirmation pattern.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, expense/attachment/background-job integration tests, the Svelte autofixer, expense E2E and visual suites, and `pnpm verify`; all must exit 0.

## Scope

**In scope**:

- trash listing, restore and permanent purge services
- retention timestamps/status and forward migration if needed
- cancellation of pending attachment deletion when restored
- expense UI, audit events, translations, background purge and tests/docs

**Out of scope**:

- restoring deleted workspaces/categories/users
- indefinite retention
- allowing member restore of records they could not currently modify/delete

## Git workflow

- Branch: `feat/015-expense-trash`
- One commit: `feat(expenses): add recoverable trash`

## Steps

### 1. Define restoration and retention invariants

Choose and document a retention window. Preserve enough attachment metadata during the window through plan 010's tombstone model. Restore must validate workspace, role, category existence/archive policy, catalog references and current payment/review permissions. Permanent purge must be advisory-locked and idempotent.

**Verify**: service tests cover valid restore, expired item, cross-workspace, missing category, concurrent restore/purge and attachment cancellation.

### 2. Implement atomic restore/purge

Restore `deleted_at`, cancel pending attachment deletions and write audit in one transaction. Purge only expired trash, enqueue/finalize attachment deletion and retain audit events. Ensure recurring-expense uniqueness behavior is defined when a replacement materialization exists.

**Verify**: rollback/concurrency integration tests pass.

### 3. Build the trash UI

Add a clearly separated trash view, not a filter that makes deleted and live expenses easy to confuse. Use a chronological retention cue (“Deleted …”, “Permanent deletion …”) as the signature. Reuse the existing expense table/card responsive patterns and confirmation dialog. Use keyed lists, `$derived` for countdown labels only from server-provided timestamps, no timer effect unless accessibility/performance justify it. All strings use `t()`.

Run the Svelte autofixer on changed components.

**Verify**: E2E covers delete → trash → restore, purge confirmation, expired background purge, RBAC, mobile layout and keyboard focus; visual snapshot passes.

### 4. Run all gates

**Verify**: migrations twice and `pnpm verify` pass.

## Test plan

- Service tests cover restore/purge boundaries, role guards, missing references and recurring uniqueness.
- Attachment tests prove deletion intent cancellation and checksum-valid restored downloads.
- Background-job tests cover expiry, advisory-lock concurrency and idempotent purge.
- E2E/visual/accessibility tests cover delete, trash, restore, purge and mobile/keyboard flows.

## Done criteria

- [ ] Deleted expenses can be restored only during the documented window.
- [ ] Restored attachments remain available and checksum-valid.
- [ ] Purge is idempotent, audited and multi-instance safe.
- [ ] Live reports never include trash rows.
- [ ] Full verify passes.

## STOP conditions

- Plan 010 has not landed or attachments cannot be restored safely.
- Restoring recurring materializations can violate unique constraints without a documented product rule.
- A restore would bypass current role/payment/review guards.

## Maintenance notes

Retention policy affects backup size and privacy obligations. Document any future change and test upgrades with existing trash rows.
