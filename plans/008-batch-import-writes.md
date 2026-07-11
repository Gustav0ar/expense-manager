# Plan 008: Batch import duplicate checks and inserts

> **Executor instructions**: Preserve current dedup semantics exactly, including legitimate identical rows within one file and serialization of concurrent workspace imports.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/imports.ts src/lib/server/db/schema.ts src/lib/server/services/*test.ts tests/quality/performance.performance.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-expand-coverage-scope.md, plans/005-bound-money-values.md
- **Category**: perf
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

An import supports 500 rows but performs a duplicate SELECT and INSERT per accepted row while holding a workspace advisory transaction lock. Large imports generate hundreds of round trips and hold the lock longer than necessary.

## Current state

- `src/lib/server/services/imports.ts:31-32`: 1 MB/500-row limits.
- `imports.ts:219-282`: loop performs per-fingerprint SELECT and per-row INSERT.
- Current semantics deliberately keep identical rows repeated inside one import while skipping matches that existed before the import.
- `src/lib/server/services/services.integration.test.ts:327-374`: re-import and concurrent-import behavior is already characterized.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run targeted import integration tests, `pnpm test:performance`, `pnpm test:coverage` and `pnpm verify`; all must exit 0.

## Scope

**In scope**:

- import duplicate lookup/insertion algorithm
- supporting composite/index migration only if EXPLAIN proves necessary
- import integration, concurrency and performance tests

**Out of scope**:

- changing the 500-row limit, file parser or dedup fingerprint definition
- preview/undo UI (plan 012)

## Git workflow

- Branch: `perf/008-batch-imports`
- One commit: `perf(imports): batch duplicate checks and inserts`

## Steps

### 1. Characterize exact semantics and query count

Add tests covering existing duplicate, two identical rows in one batch, mixed duplicates/new rows, soft-deleted matches and two concurrent imports. Add a test-only query counter or PostgreSQL statement observation that does not leak into production.

**Verify**: tests pass on current behavior and establish a baseline query count for 500 rows.

### 2. Batch candidate lookup and insertion

Under the existing advisory transaction lock, collect unique fingerprints, query existing candidates in bounded chunks, compare exact triples in memory, and bulk insert accepted rows. Preserve repeated identical rows within the same file. Keep catalog lookup batching and the audit/import-batch update in the same transaction.

If a composite index is needed, prove it with EXPLAIN and add only a forward migration plus schema metadata.

**Verify**: query count is bounded by chunks rather than rows; all semantic/concurrency tests pass.

### 3. Run performance and full gates

**Verify**: a 500-row import completes within a documented generous budget in the performance suite; `pnpm verify` passes.

## Test plan

- Existing duplicate, repeated-in-batch, soft-delete and concurrent-import cases remain unchanged.
- New 500-row fixture asserts imported/duplicate/failed counts and bounded query batches.
- Transaction rollback leaves neither partial expenses nor import batch.
- Full planning/import E2E remains green.

## Done criteria

- [ ] Dedup behavior is byte-for-byte compatible with characterized cases.
- [ ] Database round trips no longer scale one-for-one with rows.
- [ ] Concurrent same-workspace imports remain atomic.
- [ ] Full verify passes.

## STOP conditions

- PostgreSQL parameter limits require unbounded SQL construction.
- Exact duplicate semantics cannot be preserved with the proposed batching.
- An index is added without representative EXPLAIN evidence.

## Maintenance notes

If the import row limit grows, keep chunk sizes explicit and test PostgreSQL parameter limits.
