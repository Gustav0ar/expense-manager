# Plan 003: Make coverage represent the complete critical server surface

> **Executor instructions**: Expand coverage incrementally without weakening the existing 90% thresholds. Run commands inside the dev container.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- vite.config.ts src/lib/server src/routes package.json docs/development.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-repair-migration-ledger.md, plans/002-stop-password-echo.md
- **Category**: tests
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

The global 90% coverage threshold currently applies only to a manual allowlist. Critical services such as attachments, categories, expense catalogs, workspaces and MFA can regress without affecting the gate. Coverage should include the complete testable server surface and exclude only generated/framework glue with a written reason.

## Current state

- `vite.config.ts:54-85`: coverage includes a handpicked list of files.
- `src/lib/server/services/services.integration.test.ts`: exercises many omitted services but is a 2,496-line shared integration suite.
- Existing conventions: Vitest server tests use `*.test.ts`; database integration cleanup uses isolated workspace/user fixtures.

## Commands you will need

Run `pnpm test:coverage`, inspect the text/lcov report, then run `pnpm check`, `pnpm lint` and `pnpm verify` inside the container.

## Scope

**In scope**:

- `vite.config.ts`
- tests under `src/lib/server/**`
- splitting `services.integration.test.ts` by service domain if needed
- `docs/development.md`

**Out of scope**:

- lowering any existing threshold
- excluding a business service solely because its coverage is low
- production behavior changes

## Git workflow

- Branch: `test/003-complete-server-coverage`
- One commit: `test: enforce complete server coverage`

## Steps

### 1. Define principled coverage globs

Replace the allowlist with broad `src/lib/server/**/*.ts` and relevant shared utility globs. Explicitly exclude tests, generated schema relations only when untestable, and build-only entry points. Add a comment explaining every exclusion.

**Verify**: the lcov report contains attachments, categories, expense catalogs, workspaces and MFA.

### 2. Close coverage gaps with behavior tests

Add tests for meaningful branches, especially filesystem failure cleanup, membership authorization, category/catalog archive behavior and MFA persistence. Split the monolithic integration file into domain files only if shared global cleanup prevents clear ownership; preserve isolated IDs/directories and avoid order dependence.

**Verify**: `pnpm test:coverage` passes all four 90% thresholds without ignore pragmas.

### 3. Document and run all gates

Document what is covered and how to read the report.

**Verify**: `pnpm verify` exits 0.

## Test plan

- Configuration test asserts every critical service appears in the lcov input set.
- Domain tests cover omitted attachment, category, catalog, workspace and MFA branches.
- Coverage execution retains at least 90% for lines, functions, branches and statements.
- Full unit, E2E, quality and build gates remain green.

## Done criteria

- [ ] All critical server service files appear in lcov.
- [ ] No threshold was reduced.
- [ ] New tests assert behavior, not implementation-only mocks.
- [ ] Full verify passes.

## STOP conditions

- Reaching the threshold would require meaningless assertions or coverage-ignore comments.
- Integration tests cannot be made isolated without changing application behavior.
- Coverage instrumentation itself changes runtime code.

## Maintenance notes

Prefer broad inclusion with rare exclusions. A new server service should automatically enter the coverage gate without editing `vite.config.ts`.
