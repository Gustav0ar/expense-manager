# Plan 004: Enforce translation coverage in CI

> **Executor instructions**: Preserve English source keys and pt-BR dictionary values. Run every command inside the dev container.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- AGENTS.md eslint.config.js src/lib/i18n src/routes src/lib/server`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/003-expand-coverage-scope.md
- **Category**: dx, tests, bug
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Translation coverage is a manual review rule and known gaps remain. Third-party error strings can bypass the locale system, and a hardcoded fallback can silently ship because type-check/build do not validate translations.

## Current state

- `AGENTS.md:142-149`: explicitly says the build does not enforce translation coverage.
- `src/routes/(auth)/register/+page.server.ts:100-103`: returns raw `APIError.message`.
- `src/routes/(protected)/app/settings/workspace/+page.server.ts:38`: hardcoded `Update failed.` fallback.
- `src/lib/i18n/messages.ts`: English strings are keys; pt-BR values are kept alphabetically.

## Commands you will need

Run `pnpm lint`, `pnpm test:unit`, targeted auth/settings E2E specs and `pnpm verify` using the dev-container wrapper.

## Scope

**In scope**:

- current raw user-facing server errors
- `src/lib/i18n/messages.ts`
- a static i18n validation test or ESLint rule under existing tooling
- `AGENTS.md`, `docs/development.md`
- targeted unit/E2E tests

**Out of scope**:

- translating technical logs, identifiers, CSV compatibility headers or provider protocol responses
- changing the English-key dictionary architecture

## Git workflow

- Branch: `test/004-i18n-gate`
- One commit: `test(i18n): enforce user-visible translation coverage`

## Steps

### 1. Normalize current errors

Map Better Auth errors to stable translated application messages; never return provider messages directly. Translate the workspace fallback and search for equivalent raw action errors.

**Verify**: English and pt-BR E2E cases show localized, stable errors without provider text.

### 2. Add a maintainable static gate

Implement an AST-aware ESLint rule or focused test that detects the highest-risk patterns:

- string literals passed directly to `error()`/`fail()` message fields;
- raw `.message` values returned from caught third-party errors;
- visible literal text/attributes in project Svelte files where a reliable AST distinction exists.

Support a narrow documented allowlist for protocol/technical strings. Do not use a broad regex that flags imports, CSS or test selectors. Add fixture tests proving true positives and allowed cases.

**Verify**: intentionally violating each protected pattern makes the focused test/lint fail; restoring it makes the gate pass.

### 3. Update agent/developer guidance

Replace the statement that coverage is manual with the exact automated command and remaining human-review scope.

**Verify**: `pnpm verify` passes.

## Test plan

- Static-rule fixtures cover untranslated `error`/`fail`, provider `.message`, valid translated messages and protocol exceptions.
- Auth/settings E2E runs in English and pt-BR and asserts stable localized messages.
- Dictionary tests verify every introduced English key has a pt-BR value.
- Full lint and verify gates pass.

## Done criteria

- [ ] No raw provider error reaches registration UI.
- [ ] Current hardcoded user-facing server fallbacks are translated.
- [ ] CI fails on representative new untranslated errors.
- [ ] False positives have narrow, documented exceptions.
- [ ] Full verify passes.

## STOP conditions

- The proposed rule requires regex-parsing Svelte markup with unacceptable false positives.
- Better Auth lacks stable error codes for a required mapping; use a generic translated fallback and report the missing code rather than matching arbitrary prose.
- The gate would require hardcoding pt-BR strings outside the dictionary.

## Maintenance notes

Provider error codes may change on dependency upgrades. Tests should assert application messages, not provider English prose.
