# Expense Manager

Self-hosted web system for managing expenses, categories, users, dashboards, reports and financial planning.

## Stack

- SvelteKit 2 + Svelte 5
- PostgreSQL 18
- Drizzle ORM
- Better Auth
- Tailwind CSS 4
- pnpm 11
- Docker Compose + Caddy

## Features

- Email and password authentication
- Configurable email verification
- Password recovery through SMTP
- Multi-user workspaces
- Roles: owner, admin, member, viewer
- Categories
- Configurable workspace currency with money stored in cents
- Expense installments
- Category budgets with alerts
- Recurring expenses with idempotent on-demand generation
- CSV and OFX imports
- Receipt attachments with authenticated download
- Streaming upload and download for attachments
- Dashboard by period
- Reports by category, week, month, year and payment
- Analytical expense report with CSV export
- Email invitations
- MFA/TOTP with recovery codes
- Audit trail for main operations with a dedicated screen
- Healthcheck with database status and duration
- Daily backup with `pg_dump`, validation and SHA-256 checksums
- Operational Postgres observability script
- i18n-ready UI with English defaults and pt-BR translations

## Development

The recommended local workflow uses a Dev Container with Podman. You do not need to install Node.js, pnpm or Postgres on the host machine.

### With Dev Containers

Configure your Dev Containers tool to use Podman as the runtime and open this repository in the container. The container runs:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm db:migrate
```

Then, inside the container:

```bash
pnpm dev --host 0.0.0.0
```

The app runs at `http://localhost:5173`.

### With Plain Podman Compose

If you prefer not to use a Dev Containers extension:

```bash
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
podman compose -f .devcontainer/compose.yml exec app pnpm dev --host 0.0.0.0
```

The development Postgres service is named `postgres` and uses the URL defined in the devcontainer compose file.

More details are in `docs/development.md`.

## Scripts

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:e2e
pnpm test:visual
pnpm test:performance
pnpm test:infrastructure
pnpm test:smoke
pnpm test:quality
pnpm build
pnpm verify
pnpm db:generate
pnpm db:migrate
```

## VPS Deployment

1. Point the domain DNS to the VPS.
2. Copy `.env.example` to `.env`.
3. Fill `APP_DOMAIN`, `ORIGIN`, `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `REQUIRE_EMAIL_VERIFICATION`, `UPLOAD_DIR` if you want to customize the path, and SMTP.
4. Start the database:

```bash
docker compose up -d postgres
```

5. Run migrations:

```bash
docker compose --profile tools run --rm migrate
```

6. Start the application:

```bash
docker compose up -d app caddy backup
```

7. Verify:

```bash
curl -fsS https://your-domain.example/api/health
```

Optional post-deploy smoke test from a machine with access to the deployed URL:

```bash
SMOKE_BASE_URL="https://your-domain.example" pnpm test:smoke
```

Set `SMOKE_WRITE_TESTS=true` only when the environment can safely receive a generated test workspace, category and expense.

Production operations and diagnostics are in `docs/operations.md`.

## Backup And Restore

Daily Postgres and attachment backups are saved in the `backups` volume with `.sha256` files. If `BACKUP_OFFSITE_DIR` points to a mounted directory, the job also copies verified files to that destination.

Database restore:

```bash
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /path/to/backup.dump
```

Attachment restore:

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v "$(pwd)/backups:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
docker compose up -d app
```

Test restores periodically in a separate database.

## Security

- Never commit `.env`.
- Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
- Use HTTPS in production.
- Configure SMTP for password reset and invitations.
- Run migrations before publishing a new version.
- Monitor `/api/health`, disk usage, Postgres logs, backup age and `pg_stat_statements`.

## License

MIT. See `LICENSE`.
