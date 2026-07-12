# Development With Podman

This project uses `pnpm`, but the recommended local workflow does not require installing `pnpm`, Node.js or Postgres on the host machine.

## Start The Environment

```bash
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
podman compose -f .devcontainer/compose.yml exec app pnpm dev --host 0.0.0.0
```

Open `http://localhost:5173`.

## Run Verification

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm verify
```

### Server coverage

Run the coverage gate independently while developing server behavior:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm test:coverage
```

Coverage automatically instruments all TypeScript under `src/lib/server/` plus
the shared category and formatting utilities. Tests, declarative Drizzle table
schemas, and the database/authentication framework bootstrap modules are the
only exclusions because they are test inputs or composition entry points rather
than executable business behavior. Do not add a business service to the
exclusion list to make the gate pass; a new server service enters the gate
automatically.

The terminal summary shows per-file and aggregate results, and
`coverage/lcov.info` contains the machine-readable report. Lines, functions,
branches, and statements must each remain at or above 90%. Database integration
tests use isolated users, workspaces, and temporary upload directories so they
remain independent when Vitest executes files concurrently.

## Test Database Upgrades

Run the migration upgrade test after adding or changing a migration:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm test:migrations
```

The test creates an isolated temporary PostgreSQL database, migrates it through
the historical `0000`-`0008` state, upgrades it through the complete migration
ledger, verifies the MFA replay-prevention column, checks a second migration run
is idempotent, and removes the temporary database. It never targets the normal
development database. Keep migration journal timestamps increasing and add
forward-only repair migrations instead of rewriting migrations that may already
have run in deployed databases.

## Run E2E Tests

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm test:e2e
```

`pnpm test:e2e` performs one production build, then starts three separate Node
preview processes so normal, registration-lockdown and email-verification
runtime environment variables stay independent. `pnpm verify` and CI set
`PLAYWRIGHT_PREBUILT=true` only after completing the same production build, so
they do not rebuild it. Direct `playwright test` commands still build by default.
Functional configurations retain traces and screenshots only on failure, and CI
uploads `playwright-report/` plus `test-results/` for seven days.

Every local Playwright configuration derives a unique database named with the
strict `expense_manager_pw_` prefix, creates it through the configured
PostgreSQL role, applies the complete migration ledger in global setup, and
force-drops it in global teardown. Tests and preview servers receive only that
isolated URL, so browser runs never write to the persistent development
database. Concurrent suites receive different names. The database role used by
local and CI Playwright runs must have `CREATEDB`; setup fails before tests with
an explicit error when it does not. External `SMOKE_BASE_URL` runs do not create
or drop any database because they target an already deployed environment.

The teardown safety check requires the generated prefix and an exact match
between the generated name, target URL, host, port and user. It refuses the
development database, `postgres`, production-style names and cross-host
targets. If a test process is forcibly killed before teardown, remove only the
orphaned `expense_manager_pw_*` database after confirming no Playwright process
still owns it.

Playwright configurations are split by runtime mode:

| Configuration                                | Purpose                                                                       | Usual command                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `playwright.config.ts`                       | Functional route tests against the normal application configuration           | `pnpm test:e2e` or `pnpm exec playwright test src/routes/<file>.e2e.ts` |
| `playwright.registration-lockdown.config.ts` | Registration-disabled behavior with `ALLOW_REGISTRATION=false`                | Included in `pnpm test:e2e`                                             |
| `playwright.email-verification.config.ts`    | Required email-verification behavior                                          | Included in `pnpm test:e2e`                                             |
| `playwright.visual.config.ts`                | Reviewed screenshot baselines                                                 | `pnpm test:visual`                                                      |
| `playwright.performance.config.ts`           | Browser performance budgets                                                   | `pnpm test:performance`                                                 |
| `playwright.infrastructure.config.ts`        | Deployment and infrastructure assertions that do not require a browser server | `pnpm test:infrastructure`                                              |
| `playwright.smoke.config.ts`                 | Local or external post-deploy smoke coverage                                  | `pnpm test:smoke`                                                       |

Functional `*.e2e.ts` specs are colocated under `src/routes/` so route behavior and its coverage move together. Cross-cutting quality specs live under `tests/quality/`.

Reuse the identity, registration and workspace setup helpers in
`tests/playwright/fixtures.ts` when a spec only needs an authenticated starting
state. Pass the spec's locale explicitly so accessible-name assertions keep
testing the intended language. Authentication-focused specs may keep their form
steps inline when those steps are the behavior under test. Specs use Playwright's
default per-file execution mode: one failure does not skip unrelated tests, and
tests are not made parallel unless a suite opts in deliberately.

### Expense dialog actions

Support-catalog and category forms use SvelteKit progressive enhancement. Enhanced create, update, archive, delete and restore actions return a scoped `catalogAction` or `categoryAction` payload so the dialog can refresh its data and display the result without closing. Native form submissions still redirect to the validated `returnTo` URL. Keep both paths covered when adding a dialog mutation.

Attachment upload failures are rendered by the attachment panel when JavaScript is active and by the page action fallback otherwise. Do not also apply an enhanced failure to the page-level form state, or the same error will be announced twice.

Expense selection and lazily prepared detail state are cleared when the list URL changes (filters, pagination or route navigation), but retained when a same-URL action refreshes the current row.

### Expense accessibility contracts

The support-catalog picker follows the ARIA tab pattern: one tab is in the keyboard tab order, arrow keys wrap between tabs, and Home/End move to the first/last tab. Every tab controls the stable `support-catalog-panel` element.

The expense list is exposed as an ARIA table with explicit column indexes, expandable rows and a full-width details row. Responsive CSS may visually hide the header, but must keep it in the accessibility tree so column relationships remain available to assistive technology.

### Import safety contracts

File upload creates a short-lived, user- and workspace-owned preview and must not create expenses or auxiliary catalog entries. Confirmation accepts only stable source row IDs, reloads normalized rows from the server-owned preview, validates its expiry and source checksum, and reruns duplicate detection while holding the workspace import lock. Keep confirmation idempotent: repeated or concurrent submissions must return the one linked import batch.

Pending previews expire after 15 minutes. The hourly cleanup removes expired
pending previews and retains confirmed previews for one additional day so an
immediate repeated confirmation can still return the original batch result.
Preview JSON is transient workflow state and must not become permanent backup
content.

Imported expenses store a baseline hash of their material fields. Batch undo locks the batch and its expenses and soft-deletes only rows that are still unpaid, unreconciled, active and baseline-identical. Edited or financially protected rows are counted as skipped. Attachment tombstones, durable deletion intents, expense changes, batch counters and audit events belong to the same transaction; never hard-delete imported expenses during undo.

### Planning workflow routes

The planning screen is split into URL-addressable workflows under `/app/planning`:
`section=budgets`, `section=recurring`, and `section=imports`. The loader must query
only the active workflow's data; shared categories are the only common dataset.
Keep the active section in redirects, alert-history pagination, and preview-cancel
links. SvelteKit named form actions replace the page query string while an action
is being rendered, so the loader also maps each named action back to its owning
workflow. Add new planning actions to that mapping and to the workflow E2E coverage.

Delete and import undo both move expenses into a 30-day recoverable trash.
Deduplication intentionally ignores trash, so reimporting an equivalent row can
create a new live expense; restoring the older imported expense does not rewind
the import batch's undo counters. A restore revalidates current category,
catalog, currency, review, payment and reconciliation permissions and verifies
every trash-owned attachment's path, size and SHA-256 while holding the global
attachment storage lock. Independently deleted attachments are never restored.
Legacy soft-deleted rows are migrated as already expired because their files
may have been removed before durable attachment retention existed.

OFX uploads follow a separate reconciliation contract. The server parses the
original file, fingerprints the source account, and stages signed transactions
using FITID when available or a deterministic checksum plus occurrence number
when it is not. Re-uploading the same statement must not duplicate staged rows.
Credits remain visible but can only be ignored. Debit suggestions require an
exact amount and a small date window; normalized description overlap only
orders otherwise eligible candidates and is always shown as an explanation.
Postgres ranks and limits the best eight candidates independently for each bank
transaction; never reintroduce a workspace-wide candidate cutoff.

CURDEF is normalized and stored with each row. A statement currency that does
not match the workspace remains visible but can only be ignored; it cannot
match or create an expense. Legacy OFX files with no CURDEF are accepted for
compatibility and snapshot the current workspace currency when staged, so
operators should verify such files before confirming. Without FITID, identical
date/amount/text rows are distinguished by their occurrence within one file. A
truly new, identical row in a later no-FITID statement can therefore be treated
as a re-upload; this is an unavoidable conservative false-positive until the
provider supplies stable transaction identifiers.

Suggestions are read-only. Only admins and owners can confirm match, create or
ignore decisions. Confirmation locks the staged transaction and candidate
expense, then writes the payment-state transition, one-to-one transaction link
and audit event in one database transaction. Never accept normalized OFX rows,
amounts, dates or eligibility claims from the browser, and never auto-reconcile.
Material edits, rejection, payment reset and moving a linked expense to trash
must reopen the bank transaction and record `bank_transaction.reversed` in the
same database transaction. A reopened expense retains its payment date and
becomes paid unless the requested transition explicitly makes it unpaid. An
edit that leaves amount, date, currency and financial state compatible keeps
the verified link. Database integrity triggers guard service bypasses and use a
transaction-scoped advisory lock to serialize direct expense/link mutations.
The ledger-to-expense foreign key uses `ON DELETE SET NULL`, so a later hard
retention purge or operator-level hard delete cannot erase the bank ledger row
or its audit history. Normal soft deletion reopens the transaction first.

### Invitation membership contracts

Invitations add new members or explicitly reactivate disabled non-owner
memberships. They are never a role-change mechanism for an active member and
must never overwrite an owner membership. Invitation creation rejects an email
that already belongs to an active member, while acceptance repeats the
membership check under a row lock so legacy or concurrently accepted links
cannot bypass the invariant. Use the dedicated member-role action for active
members.

### Workspace currency contracts

A workspace currency can change only while no currency-dependent state exists.
The guard includes every expense (live or in the 30-day trash), recurring
schedule, budget, unexpired import preview and pending legacy bank transaction
that predates currency snapshots. Explicit-currency bank rows remain valid
history and do not block a change: after a change, mismatched pending rows can
only be ignored.

Currency changes and all application paths that create expenses, recurring
schedules, budgets, import previews or staged bank transactions share one
transaction-scoped advisory lock per workspace. Writers read the current
currency after taking that lock instead of trusting a request-cached value.
This makes either concurrency order safe: an existing/new monetary artifact
blocks the change, while a writer queued behind a successful change persists
the new currency. Do not bypass these service transactions when adding a new
monetary write path.

### Analytical CSV export contract

Expense-level analytical CSV exports are not capped. The server keyset-paginates
expenses in bounded batches of 1,000, ordered by `expense_date DESC, id DESC`,
and aggregates attachment counts once per batch. Keep this ordering and the CSV
formula-injection protection when changing the export.

Each download holds one database connection in a read-only, repeatable-read
transaction. Its maximum expense ID is captured inside that snapshot, so inserts
or edits committed after the export starts cannot produce a mixed or duplicated
file. The transaction and reserved connection are released when the stream
finishes, fails or is cancelled. Operators should investigate slow or abandoned
downloads because a long-running snapshot can delay PostgreSQL vacuum cleanup.

### Portable expense CSV contract

The portable expense CSV is a separate interchange format from the analytical
report. Version 1 starts with `# expense-manager-expenses:v1`, followed by the
canonical import columns `date`, `description`, `amount`, `category`,
`payment_method`, `vendor`, `cost_center` and `notes`. Amounts are decimal major
currency units, while category and support-catalog values are their raw names;
localized analytical labels, category icons and cent values never belong in
this format.

`/app/reports/portable.csv` applies the current report filters and refuses more
than 500 expenses or a result above 1 MB, matching both import preview limits.
Narrow the date or catalog filters and create multiple files for larger
transfers. The versioned parser reverses the format's spreadsheet-formula
protection, including literal leading apostrophes, so an untouched export can be
imported without changing those fields. `/app/reports/portable-template.csv`
provides the marker and header with no example expense that could be imported
accidentally.

This format recreates the fields accepted by expense import. It is not a backup
and intentionally does not preserve database IDs, attachments, competency,
installments, audit history, review state, payment state or reconciliation state.
Use the database and attachment backup workflow for disaster recovery. Existing
unversioned CSV imports remain supported; reject unknown portable versions rather
than guessing their meaning.

### CSS ownership

`src/routes/layout.css` contains application-wide primitives and styles shared by multiple routes. Expense-page, support-catalog, attachment and bulk-review rules live in `src/routes/(protected)/app/expenses/expenses.css`, which is imported by the expense page and emitted as a route-only CSS asset. Add new expense-specific responsive rules there instead of growing the global stylesheet.

## Run Quality Gates

The quality gates add screenshot regression, performance budget, infrastructure failure and smoke coverage on top of the functional E2E suite:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm test:visual
podman compose -f .devcontainer/compose.yml exec app pnpm test:performance
podman compose -f .devcontainer/compose.yml exec app pnpm test:query-plans
podman compose -f .devcontainer/compose.yml exec app pnpm test:infrastructure
podman compose -f .devcontainer/compose.yml exec app pnpm test:smoke
podman compose -f .devcontainer/compose.yml exec app pnpm test:prometheus-rules
podman compose -f .devcontainer/compose.yml exec app pnpm test:quality
```

`pnpm test:quality` includes all four Playwright quality suites, the bounded-query
plan regression gate and Prometheus rule scenarios. The query-plan gate runs
`EXPLAIN (FORMAT JSON)` against realistic catalog usage and fails when an
unbounded per-row query pattern returns. Rebuild the development container after
changing `.devcontainer/Containerfile` so `promtool` is available. CI runs the
Playwright suites and query-plan gate as a parallel matrix, with Prometheus rules
as a separate required job, while functional E2E remains in the main verification
job.

The client asset budgets are measured from a production build under
`.svelte-kit/output/client/_app/immutable`. Vite replaces this output on every
build, so hashed files from an earlier build are not counted. When an intentional
client feature changes an aggregate ceiling, run at least three clean production
builds, document the observed range next to the budget, and keep only narrow
headroom above the maximum. Do not raise a ceiling for an unexplained bundle
increase or a single non-reproducible result.

Update visual baselines only after intentionally reviewing UI changes:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright test \
  --config playwright.visual.config.ts \
  --update-snapshots
```

## Reset The Local Database

```bash
podman compose -f .devcontainer/compose.yml down -v
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
```
