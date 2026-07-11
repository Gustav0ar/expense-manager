# Plan 012: Add import preview and safe batch undo

> **Executor instructions**: Preserve current direct import behavior until the preview path is fully tested, then switch atomically. Use Svelte 5 runes and run the Svelte autofixer on every changed component.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/imports.ts src/lib/server/db/schema.ts src/routes/'(protected)'/app/planning src/lib/i18n/messages.ts drizzle`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-enforce-i18n.md, plans/005-bound-money-values.md, plans/008-batch-import-writes.md
- **Category**: direction, feature
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

CSV/OFX imports currently commit immediately. The existing `import_batch` and `expense.import_batch_id` relationship makes preview and guarded undo feasible, reducing the cost of a wrong category mapping or wrong file.

## Current state

- `src/lib/server/services/imports.ts:62-317`: parse, validate, deduplicate and commit are one operation.
- `src/lib/server/db/schema.ts:460-485`: import batch stores counts and failures.
- `schema.ts:524-526`: imported expenses reference their batch.
- `src/routes/(protected)/app/planning/+page.svelte:319-409`: upload form and batch history share one panel; no preview/undo actions.

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, targeted import service tests, the Svelte autofixer on changed components, `pnpm exec playwright test src/routes/app.e2e.ts --grep "import" --timeout=60000`, visual/performance suites and `pnpm verify`; all must succeed.

## Scope

**In scope**:

- preview/staging service and any forward schema migration
- confirm-import and guarded undo actions
- planning import UI, translations and responsive styles
- audit events, unit/integration/E2E/visual/accessibility tests and docs

**Out of scope**:

- bank-statement matching (plan 013)
- imports larger than current limits
- undoing expenses edited, paid, reconciled or detached from the batch

## Git workflow

- Branch: `feat/012-import-preview-undo`
- One commit: `feat(imports): add preview and guarded undo`

## Steps

### 1. Separate parsing/analysis from commit

Create a pure analysis result containing normalized rows, proposed category/catalog mappings, duplicates and failures. Persist a short-lived preview server-side with workspace/user ownership and expiry, or protect a compact payload cryptographically; never trust client-posted normalized rows. Confirmation must revalidate ownership, expiry and source checksum.

**Verify**: unit tests prove preview performs no expense writes and confirm is idempotent.

### 2. Implement guarded batch undo

Undo only expenses still matching immutable import baseline conditions: same batch, not deleted, unpaid, not reconciled and not materially edited after import. Prefer storing an import baseline/version if `updated_at` alone cannot distinguish initial writes. Perform expense soft deletion and audit atomically; report skipped rows precisely.

**Verify**: integration tests cover full undo, partial refusal, wrong workspace, repeat undo and concurrent edit.

### 3. Build a transaction-review UI

Use the existing panel/table/status-pill vocabulary. The distinctive element should be a compact review ledger: each row visibly maps source description/amount to proposed category, with failures and duplicates grouped—not a generic wizard. Use keyed each blocks, `$derived` for counts, `$state` only for local selection, no state-updating effects, and existing dialog confirmation patterns. All text uses `t()`.

Run `npx @sveltejs/mcp svelte-autofixer` on every changed `.svelte` file.

**Verify**: E2E covers upload → preview → confirm, cancel, error rows, undo and refused undo; visual tests cover desktop/mobile and keyboard focus.

### 4. Run all gates

**Verify**: migrations twice, `pnpm verify`, visual and performance suites pass.

## Test plan

- Pure analysis tests cover valid, duplicate, failed and mapped rows without writes.
- Confirmation tests cover ownership, expiry, checksum, idempotency and concurrency.
- Undo tests cover full success, partial refusal, edited/paid/reconciled rows and cross-workspace denial.
- E2E/visual/accessibility tests cover desktop/mobile preview, confirm, cancel and undo.

## Done criteria

- [ ] Upload alone writes no expenses.
- [ ] Confirmation is server-authoritative and idempotent.
- [ ] Undo cannot remove subsequently changed financial records.
- [ ] UI is localized, keyboard accessible and responsive.
- [ ] Full verify passes.

## STOP conditions

- A preview design requires trusting normalized client data.
- Existing timestamps cannot safely identify changed imported expenses; add an explicit baseline or stop.
- Undo would hard-delete audit-relevant expense rows.

## Maintenance notes

Preview analysis should become the shared input for reconciliation in plan 013. Keep source row identifiers stable across preview and commit.
