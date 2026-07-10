# Agent Guidelines

## Development environment

The project uses a **dev container** (`.devcontainer/`) backed by Podman. All build, test, and runtime commands must run inside the container, not on the host — the host lacks the right Node version, pnpm, and the Playwright browser deps.

The host uses `podman compose` directly. **Never invoke `docker`, `docker compose`, or `docker-compose`, and do not set `DOCKER_HOST`.**

### Start the container

```bash
podman compose --file .devcontainer/compose.yml up -d
```

The `postgres` service starts automatically. The `app` service mounts the repo at `/workspaces/expense-manager`.

### Run commands inside the container

```bash
podman compose --file .devcontainer/compose.yml exec app sh -c "cd /workspaces/expense-manager && <command>"
```

### Common commands (all run inside the container)

| Task                   | Command                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| Install deps           | `CI=true pnpm install --frozen-lockfile`                             |
| Run migrations         | `pnpm db:migrate`                                                    |
| Dev server (port 5173) | `pnpm dev`                                                           |
| Build                  | `pnpm build`                                                         |
| Unit tests             | `pnpm test:unit`                                                     |
| E2E tests              | `pnpm exec playwright test src/routes/<file>.e2e.ts --timeout=60000` |
| All E2E                | `pnpm test:e2e`                                                      |
| Type check             | `pnpm check`                                                         |

### Working with worktrees

Worktrees live inside the repo (`.claude/worktrees/<name>/`) and are mounted into the container at the same path under `/workspaces/expense-manager/.claude/worktrees/<name>/`. To run commands in a worktree:

```bash
podman compose --file .devcontainer/compose.yml exec app sh -c \
  "cd /workspaces/expense-manager/.claude/worktrees/<name> && CI=true pnpm install --frozen-lockfile && pnpm build"
```

The worktree shares the same postgres service as the main workspace. Each worktree needs its own migration run (`pnpm db:migrate`) if the schema has changed relative to HEAD.

### Environment variables

The container injects all required env vars via `.devcontainer/compose.yml`. Notable values:

- `DATABASE_URL`: `postgres://expense_manager:expense_manager@postgres:5432/expense_manager`
- `ORIGIN`: `http://localhost:5173`
- `BETTER_AUTH_SECRET`: `development-secret-development-secret-32`
- `REQUIRE_EMAIL_VERIFICATION`: `false`

Do **not** set these manually when running inside the container — they are already present.

### Playwright / E2E

Playwright chromium is pre-installed in the container at `/home/node/.cache/ms-playwright/`. The `playwright.config.ts` builds the app and starts `pnpm preview` on port 4173 automatically before running tests — no manual server start needed.

The `postCreateCommand` in `devcontainer.json` runs `pnpm install`, `playwright install chromium`, and `pnpm db:migrate` automatically on container creation.

**Known pre-existing E2E failure:** `settings.e2e.ts` › `covers security MFA setup…` fails on HEAD due to a timing issue with `'MFA ativado.'` text — not caused by our changes.

Functional Playwright specs are intentionally colocated with routes as `src/routes/*.e2e.ts`. Runtime-specific registration and email-verification specs also live under `src/routes/`, while visual, performance, infrastructure and smoke specs live under `tests/quality/`. See `docs/development.md` for the configuration-to-suite map.

### When a test fails after UI changes

E2E helpers that scrape page text may need updating when the UI changes. The invite URL helpers in `users.e2e.ts`, `settings.e2e.ts`, and `reports.e2e.ts` extract the URL from `.invite-url-row .invite-url-code` — not the old `.notice.success` text. The remove-member flow in `users.e2e.ts` now requires a dialog confirmation (click "Remover" on the row, then click "Remover" in the dialog).

- Write default product UI text, documentation, server messages and tests in English.
- When a user-facing string needs pt-BR support, add the English source string to the UI/server code and add the pt-BR translation in `src/lib/i18n/messages.ts`.
- Do not hardcode pt-BR text outside i18n dictionaries, except for compatibility aliases that intentionally accept external input such as CSV headers.
- When writing pt-BR text for translations, documentation, messages, tests or fixtures, use correct spelling with accents and special characters: `descrição`, `configuração`, `usuários`, `ações`, `permissão`, `código`, `não`, `orçamento`, `relatórios`.
- Preserve unaccented text only when it is a technical identifier, route, database column, environment variable, API key, filename or external compatibility alias.

## i18n — Every user-visible string must be translated

**This is a hard rule. Every user-visible string must go through the translation system.**

### In `.svelte` files

Always wrap text through the local `t()` helper, which is defined in each page as:

```ts
function t(key: string, params?: Record<string, string | number | null | undefined>) {
	return translate(data.locale, key, params);
}
```

This applies to:

- Template text content: `{t('Save')}` not `Save`
- HTML attributes: `placeholder={t('Search')}`, `aria-label={t('Close')}`, `title={t('Edit')}`
- `<option>` labels: `<option value="member">{t('Member')}</option>` not `Member`
- Dynamic data that comes from a fixed enum (role names, status values): translate them with a helper map
- Page `<title>`: `<title>{t('Dashboard')} | Expense Manager</title>`
- Default input values: `value={t('My expenses')}` not `value="My expenses"`

### In server `.ts` files

Always use `translate(context.locale, 'key')` for user-facing errors:

```ts
throw error(403, translate(context.locale, 'Permission denied.'));
throw error(404, translate(context.locale, 'Budget not found.'));
```

**Never** write: `throw error(403, 'Permission denied.')` — the English string will be shown even to pt-BR users.

When a service function does not receive a `WorkspaceContext`, add a `locale: SupportedLocale = 'en'` parameter and thread it from the caller.

### Adding new strings

1. Use the English string as the key in your template/server code.
2. Add the pt-BR translation to `src/lib/i18n/messages.ts` inside `ptBrMessages`.
3. The file is sorted alphabetically — add the key in the correct position.
4. Never add a string that is only in one place; if it's user-visible, it needs a pt-BR entry.

### Common mistakes to avoid

- Hardcoding English `<span>Email</span>` instead of `<span>{t('Email')}</span>`
- Raw database enum values rendered directly: `{invitation.status}` → translate to `{translateStatus(invitation.status)}`
- Catalog/example placeholder text: `placeholder: 'Operations'` → `placeholder: t('Example cost center')`
- `throw error(403, 'Permission denied.')` without `translate()`
- New service functions that throw errors without translating them

### Checking your work

After any change that introduces user-visible text, search for bare English strings in your diff:

- In `.svelte` templates, any visible text not inside `{t('...')}` is a bug
- In server `.ts` files, any `throw error(N, 'English string')` without `translate()` is a bug

The build does not enforce translation coverage, so this must be done by code review.
