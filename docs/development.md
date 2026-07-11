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

### Expense dialog actions

Support-catalog and category forms use SvelteKit progressive enhancement. Enhanced create, update, archive, delete and restore actions return a scoped `catalogAction` or `categoryAction` payload so the dialog can refresh its data and display the result without closing. Native form submissions still redirect to the validated `returnTo` URL. Keep both paths covered when adding a dialog mutation.

Attachment upload failures are rendered by the attachment panel when JavaScript is active and by the page action fallback otherwise. Do not also apply an enhanced failure to the page-level form state, or the same error will be announced twice.

Expense selection and lazily prepared detail state are cleared when the list URL changes (filters, pagination or route navigation), but retained when a same-URL action refreshes the current row.

### Expense accessibility contracts

The support-catalog picker follows the ARIA tab pattern: one tab is in the keyboard tab order, arrow keys wrap between tabs, and Home/End move to the first/last tab. Every tab controls the stable `support-catalog-panel` element.

The expense list is exposed as an ARIA table with explicit column indexes, expandable rows and a full-width details row. Responsive CSS may visually hide the header, but must keep it in the accessibility tree so column relationships remain available to assistive technology.

### CSS ownership

`src/routes/layout.css` contains application-wide primitives and styles shared by multiple routes. Expense-page, support-catalog, attachment and bulk-review rules live in `src/routes/(protected)/app/expenses/expenses.css`, which is imported by the expense page and emitted as a route-only CSS asset. Add new expense-specific responsive rules there instead of growing the global stylesheet.

## Run Quality Gates

The quality gates add screenshot regression, performance budget, infrastructure failure and smoke coverage on top of the functional E2E suite:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm test:visual
podman compose -f .devcontainer/compose.yml exec app pnpm test:performance
podman compose -f .devcontainer/compose.yml exec app pnpm test:infrastructure
podman compose -f .devcontainer/compose.yml exec app pnpm test:smoke
podman compose -f .devcontainer/compose.yml exec app pnpm test:prometheus-rules
podman compose -f .devcontainer/compose.yml exec app pnpm test:quality
```

`pnpm test:quality` includes all four Playwright quality suites plus Prometheus rule scenarios. Rebuild the development container after changing `.devcontainer/Containerfile` so `promtool` is available. CI runs the Playwright suites as a parallel matrix and Prometheus rules as a separate required job, while functional E2E remains in the main verification job.

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
