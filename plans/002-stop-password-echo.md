# Plan 002: Prevent authentication actions from echoing secrets

> **Executor instructions**: Follow this plan exactly and run all commands inside the dev container. Do not log, snapshot or reproduce a submitted password in tests.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/routes/'(auth)'/login src/routes/auth.e2e.ts src/lib/server`

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security, bug
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

The login action returns the entire submitted `FormData` when validation fails. That object includes the password and is serialized back to the browser even though the UI only needs email and redirect state. Authentication action responses must use an allowlist of safe fields.

## Current state

- `src/routes/(auth)/login/+page.server.ts:33-37`: validation failure returns `values: Object.fromEntries(formData)`.
- `src/routes/(auth)/login/+page.svelte:75-93`: only `form.values.email` is reused; the password input is intentionally blank.
- `src/routes/(auth)/register/+page.server.ts:182-187`: `safeValues` is the existing allowlist pattern.

## Commands you will need

Use the `COMPOSE` detection in `AGENTS.md` and the standard wrapper. Run `pnpm check`, `pnpm test:unit`, the targeted auth Playwright spec, then `pnpm verify`.

## Scope

**In scope**:

- `src/routes/(auth)/login/+page.server.ts`
- a route-level unit test for the login action (new or existing appropriate file)
- `src/routes/auth.e2e.ts`

**Out of scope**:

- changing login messages, rate limits, Better Auth configuration or session behavior
- persisting passwords in fixtures, logs or snapshots

## Git workflow

- Branch: `fix/002-auth-secret-echo`
- One commit: `fix(auth): exclude secrets from action responses`

## Steps

### 1. Replace broad form echoing with an allowlist

Return only `email` and sanitized `next` on validation failure. Prefer a named helper matching registration's `safeValues` convention. Search every route action for returned `Object.fromEntries(formData)` and fix any other response that can contain a password, token or file.

**Verify**: `rg -n "values: Object\.fromEntries" src/routes` returns no secret-bearing action response.

### 2. Add regression tests

Add a route-level test that submits an invalid login with a sentinel password and asserts the returned action data contains email/next but has neither a `password` property nor the sentinel anywhere in serialized output. Extend `auth.e2e.ts` to submit an invalid form, assert the email remains populated, the password is empty, and the response/body captured by Playwright does not contain the sentinel.

**Verify**: targeted unit and `pnpm exec playwright test src/routes/auth.e2e.ts --timeout=60000` pass.

### 3. Run the full gate

**Verify**: `pnpm verify` exits 0.

## Test plan

- Route unit test: invalid login returns only email and safe redirect state.
- Serialization assertion: neither password key nor submitted sentinel appears.
- Auth E2E: email is retained, password input is empty, normal login still succeeds.
- Regression gate: full `pnpm verify`.

## Done criteria

- [ ] No authentication failure response contains password/passwordConfirmation/token values.
- [ ] Email and safe redirect state still repopulate.
- [ ] Unit and E2E regression tests pass.
- [ ] `pnpm verify` passes.

## STOP conditions

- The generated SvelteKit action type requires returning the password.
- A test framework diagnostic prints the sentinel password.
- Fixing this requires changing Better Auth internals.

## Maintenance notes

Any future action that echoes submitted values must use an explicit safe-field allowlist. Review file and token inputs with the same rule.
