# Plan 006: Commit business mutations and audit events atomically

> **Executor instructions**: Refactor one service domain at a time and keep each intermediate state passing tests. Run commands inside the dev container.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services src/lib/server/db/schema.ts src/routes`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/003-expand-coverage-scope.md
- **Category**: bug, tech-debt
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Many service methods commit their business mutation and then insert an audit event using a separate database operation. If audit insertion fails, the mutation remains committed while the caller receives an error and may retry. Audit integrity should be part of the same transaction as every audited database mutation.

## Current state

- `src/lib/server/services/audit.ts:15-23`: `writeAuditEvent` always uses global `db`.
- `src/lib/server/services/categories.ts:69-85`: create and audit are separate.
- `src/lib/server/services/expenses.ts:385-436`: update and audit are separate.
- `src/lib/server/services/workspaces.ts:300-339`: role change and audit are separate.
- Transactional exemplars: `createExpense` in `expenses.ts:308-348` and attachment creation in `attachments.ts:76-101` insert audit rows through `tx`.

## Commands you will need

Use the Compose detection and exec wrapper from `AGENTS.md`. Run `pnpm check`, `pnpm test:coverage`, targeted service integration tests and `pnpm verify`; expected result is exit 0 with all tests passing.

## Scope

**In scope**:

- all mutating service functions that write audit events
- `src/lib/server/services/audit.ts`
- domain integration tests and failure-injection tests

**Out of scope**:

- filesystem deletion atomicity (plan 010)
- email-provider delivery (plan 009)
- changing audit event names or metadata contracts

## Git workflow

- Branch: `refactor/006-atomic-audit-events`
- One commit: `refactor: make audit events transactionally consistent`

## Steps

### 1. Add a transaction-aware audit insertion primitive

Define a narrow database-executor type accepted by an audit insertion helper, or keep audit values construction pure and call it with `db`/`tx`. Avoid `any`; use Drizzle's inferred transaction type or a minimal compatible interface. Preserve the public standalone helper only for events with no paired mutation.

**Verify**: type-check and audit helper unit tests pass.

### 2. Wrap every paired mutation

Audit categories, catalog items, category rules, expenses, budgets, recurrences, workspace settings and membership changes. For functions already using a transaction, move audit insertion inside it. For optimistic updates, ensure the audit occurs only after the guarded update returns a row.

**Verify**: `rg -n -B12 "await writeAuditEvent|await db\.insert\(auditEvent\)" src/lib/server/services` shows no paired mutation outside its transaction.

### 3. Add rollback characterization tests

For at least category creation, expense review/payment and member role change, force audit insertion to fail using a database constraint or controlled transaction test and assert the business mutation rolls back. Also verify success creates exactly one audit row.

**Verify**: domain integration tests and `pnpm test:coverage` pass.

### 4. Run all gates

**Verify**: `pnpm verify` passes.

## Test plan

- Success tests assert one mutation and one matching audit event.
- Failure injection covers category, expense payment/review and membership changes.
- Optimistic-concurrency failures assert neither mutation nor audit event commits.
- Existing audit pagination/filter E2E remains green.

## Done criteria

- [ ] Every audited database mutation and its audit event share one transaction.
- [ ] Failure-injection tests prove rollback.
- [ ] Event action names/metadata remain compatible.
- [ ] Full verify passes.

## STOP conditions

- A mutation has an intentionally post-commit audit event documented as an external side effect; report it instead of forcing it into the transaction.
- Drizzle transaction typing requires `any` or unsafe casts.
- Failure injection would require production-only hooks.

## Maintenance notes

Reviewers should reject new `mutation; await writeAuditEvent(...)` sequences unless the mutation is itself non-transactional and documented.
