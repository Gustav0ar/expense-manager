# Plan 007: Eliminate multiplicative usage-count joins

> **Executor instructions**: Preserve every returned field and archive/delete decision. Measure query plans before and after in disposable data.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/categories.ts src/lib/server/services/expense-catalogs.ts src/lib/server/services/services.integration.test.ts scripts docs/operations.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-expand-coverage-scope.md
- **Category**: perf
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Category usage counts join several one-to-many relations before aggregating with `count(distinct ...)`. A category with many expenses and several rules/recurrences creates a large intermediate Cartesian result on every expense, planning and reports load. Payment-method counts repeat the same pattern for expenses and recurrences.

## Current state

- `src/lib/server/services/categories.ts:24-57`: joins expense, recurring expense, budget, rule and child category in one grouped query.
- `src/lib/server/services/categories.ts:196-229`: repeats the query for a single category.
- `src/lib/server/services/expense-catalogs.ts:325-340`: payment methods join both expense and recurrence.
- `src/routes/(protected)/app/expenses/+page.server.ts:52-57`: these counts run on a core page load.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run targeted service integration tests, `pnpm test:performance`, `pnpm test:coverage` and `pnpm verify`; all must exit 0.

## Scope

**In scope**:

- category and expense-catalog usage queries
- query-result tests
- a deterministic seed/benchmark or EXPLAIN regression script
- relevant performance documentation

**Out of scope**:

- changing response shapes, archive behavior or page UI
- speculative index removal

## Git workflow

- Branch: `perf/007-usage-count-queries`
- One commit: `perf(db): preaggregate category and catalog usage`

## Steps

### 1. Record a representative baseline

In a disposable workspace seed thousands of expenses plus multiple rules, recurrences, budgets and child categories. Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for current category and payment-method queries. Keep only sanitized plan metrics/fixtures, not environment details.

**Verify**: baseline test asserts exact usage counts across mixed associations.

### 2. Replace cross products with pre-aggregation

Use per-table grouped CTEs joined by category/catalog ID, or equivalent lateral aggregates. Scan each association table once per workspace. Reuse one query-construction shape for list and single-item decisions where practical.

**Verify**: all count and archive/delete integration tests pass; output ordering is unchanged.

### 3. Prove the improvement

Run the same seeded EXPLAIN. Assert result equality and document reduced intermediate rows/runtime without hardcoding unstable wall-clock limits in unit tests.

**Verify**: `pnpm test:performance` and `pnpm verify` pass.

## Test plan

- Mixed-association fixtures assert every usage count and ordering.
- Archive/delete behavior uses the optimized query results.
- Seeded EXPLAIN comparison records intermediate rows and buffer activity.
- Core page performance and full regression suites pass.

## Done criteria

- [ ] No usage query multiplies independent one-to-many joins.
- [ ] Exact counts and archive decisions are unchanged.
- [ ] Before/after query evidence is documented.
- [ ] Full verify passes.

## STOP conditions

- PostgreSQL's measured plan is not materially better on representative data.
- The refactor changes count semantics for deleted/archived rows.
- A new index is proposed without EXPLAIN evidence.

## Maintenance notes

When new category associations are added, add a separate pre-aggregated count rather than another raw one-to-many join.
