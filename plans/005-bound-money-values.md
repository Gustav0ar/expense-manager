# Plan 005: Guarantee safe monetary integer boundaries

> **Executor instructions**: Define one explicit product maximum and apply it consistently. Run all commands inside the dev container.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/utils/money.ts src/lib/server/validation.ts src/lib/server/db/schema.ts drizzle src/lib/server/services src/lib/i18n/messages.ts`

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: plans/001-repair-migration-ledger.md, plans/004-enforce-i18n.md
- **Category**: bug, migration
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Money is stored in PostgreSQL `bigint` but represented as JavaScript `number`. `parseCurrencyToCents` does not reject values beyond `Number.MAX_SAFE_INTEGER`, so accepted input can be rounded silently. A clear domain maximum avoids precision loss and gives users a validation error instead of a database failure.

## Current state

- `src/lib/server/utils/money.ts:18-21`: constructs and returns cents without a safe-integer check.
- `src/lib/server/validation.ts:157-176,229-248,251-270`: expense, budget and recurrence schemas all delegate to the parser.
- `src/lib/server/db/schema.ts:230,422,502`: monetary columns use bigint mode `number` and only enforce `> 0`.

## Commands you will need

Detect `COMPOSE` as documented in `AGENTS.md`, then run `$COMPOSE --file .devcontainer/compose.yml exec app sh -c "cd /workspaces/expense-manager && <command>"` with `pnpm db:migrate` (twice), `pnpm test:unit`, targeted expense/planning E2E, and `pnpm verify`. Every command must exit 0.

## Scope

**In scope**:

- shared money parser/constants/tests
- expense, budget, recurrence and import validation
- forward-only database check constraints through a new migration
- English/pt-BR validation messages
- unit/integration/E2E boundary tests

**Out of scope**:

- converting the entire application to JavaScript `bigint`
- changing existing valid stored amounts or currency formatting

## Git workflow

- Branch: `fix/005-money-boundaries`
- One commit: `fix(money): enforce safe amount boundaries`

## Steps

### 1. Define and enforce a domain maximum

Choose a maximum safely below `Number.MAX_SAFE_INTEGER` cents and appropriate for a self-hosted expense workspace. Export the cents constant from the money utility. Parse integer/fraction components without allowing an intermediate unsafe number; reject values above the maximum with a stable error key.

**Verify**: unit tests cover maximum accepted, one cent above rejected, huge input rejected, locale separators, imports and normal existing amounts.

### 2. Add database defense in depth

Create a new forward-only migration adding/replacing check constraints for expense, recurring expense and category budget amounts: `amount_cents > 0 AND amount_cents <= <maximum>`. Update Drizzle schema constraints and metadata. Do not rewrite old migrations.

**Verify**: fresh and upgrade migration tests pass; direct out-of-range inserts fail while boundary inserts succeed.

### 3. Verify user flows

Add focused E2E assertions for expense and budget forms showing localized validation and preserving safe fields.

**Verify**: targeted E2E plus `pnpm verify` pass.

## Test plan

- Money utility table tests at zero, one cent, maximum, maximum plus one and oversized digit strings.
- Direct database constraint tests for all three money tables.
- Import, expense, recurrence and budget validation tests use the same boundary.
- English/pt-BR E2E asserts localized rejection and ordinary-value success.

## Done criteria

- [ ] No parser path returns an unsafe integer.
- [ ] All money-bearing tables enforce the same maximum.
- [ ] Existing ordinary data remains valid.
- [ ] Unit, migration, integration and E2E boundary tests pass.

## STOP conditions

- Existing fixture or real migration-test data exceeds the proposed maximum.
- The chosen maximum requires product-owner judgment not documented in the repo; stop with measured candidate ranges.
- Drizzle proposes altering historical migrations.

## Maintenance notes

Any future money-bearing column must reuse the shared maximum and matching database constraint.
