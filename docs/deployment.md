# VPS Deployment

For a public GitHub repository deployed to a private VPS behind Traefik, use
[`DEPLOY.md`](../DEPLOY.md) as the primary production runbook. It includes the
protected GitHub environment, GHCR images, dedicated deploy user, Traefik
compose file and the rules for keeping hostnames, IPs and secrets out of Git.

The notes below describe the direct Docker Compose deployment that is useful for
local production-like testing or for a standalone Caddy deployment.

## Requirements

- Docker Engine with Docker Compose
- `pnpm` does not need to be installed on the VPS; the Docker image installs dependencies during the build
- Domain pointed to the VPS
- Ports 80 and 443 open
- Email delivery configured for password reset, verification, invitations and budget alerts.
  See [`docs/email.md`](email.md) for the Mailjet setup.
- Remote object storage or another off-VPS restic backend for encrypted backups
- Persistent space for the `uploads` volume, used by receipt attachments

## Required Variables

- `APP_DOMAIN`
- `ORIGIN`
- `BETTER_AUTH_SECRET`
- `ALLOW_REGISTRATION`: set to `false` to disable public self-service account registration. Both
  the Caddy and Traefik Compose deployments pass this value into the application container.
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `RESTIC_REPOSITORY`
- `RESTIC_PASSWORD`

## Recommended Variables

- `UPLOAD_DIR`: attachment path inside the container. The compose file uses `/app/uploads` by default.
- `DB_POOL_MAX`: maximum application query-pool size. Each app process may open one additional dedicated connection while holding a scheduler advisory lock.
- `TRUST_PROXY_HEADERS`: use `true` only when the app is not directly exposed and only receives traffic through a trusted reverse proxy. The default `docker-compose.yml` sets it to `true` because Caddy is the only published service.
- `TRUSTED_PROXY_CIDR`: immediate reverse proxy subnet allowed to supply forwarded client addresses. It is required when `TRUST_PROXY_HEADERS=true` and accepts comma-separated IPv4/IPv6 CIDRs. The Compose default covers Docker's standard private bridge range; override it for custom networks.
- `TRUSTED_ORIGINS`: comma-separated extra origins for alternate URLs, VPN or Tailscale access. Use complete origins such as `https://finance.example.com` or `http://100.x.y.z:5173`.
- `RESTIC_KEEP_DAILY`, `RESTIC_KEEP_WEEKLY`, `RESTIC_KEEP_MONTHLY`: remote retention policy. The default keeps 7 daily, 4 weekly and 12 monthly snapshots.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`: required only for S3-compatible restic repositories.
- `APP_MEM_LIMIT`, `APP_CPUS`, `POSTGRES_MEM_LIMIT`, `POSTGRES_CPUS`, `CADDY_MEM_LIMIT`, `BACKUP_MEM_LIMIT`: optional operational limits for tuning VPS resource usage.

## First Release

```bash
cp .env.example .env
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose up -d app caddy backup
```

The `backup` service writes encrypted backups to the remote `RESTIC_REPOSITORY`. During each run it creates a temporary Postgres custom-format dump, a temporary `uploads_*.tar.gz` archive and `.sha256` checksums. The dump is validated with `pg_restore --list`, the uploads package is validated with `tar -tzf`, and then all artifacts are uploaded to the remote restic repository. Temporary local files are removed when the run finishes.

## Restore

Restore from the remote repository into a temporary restore directory first:

```bash
docker compose run --rm --no-deps \
  --entrypoint restic \
  -v "$(pwd)/restore:/restore" \
  backup restore latest --target /restore
```

Then restore Postgres:

```bash
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /restore/path/from/restic/expense_manager_YYYYMMDDTHHMMSSZ.dump
```

Then restore the attachments matching the same dump timestamp:

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v "$(pwd)/restore:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
docker compose up -d app
```

Validate restores in a separate database before relying on them in production.

## Update

```bash
git pull
docker compose build app migrate
docker compose --profile tools run --rm migrate
docker compose up -d app
docker compose exec app wget -qO- http://localhost:3000/api/health
```

## Operational Diagnostics

To review slow queries, lock waits, index size, dead tuples and unused-index candidates:

```bash
docker compose exec -T postgres psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  < scripts/postgres-observability.sql
```

Details and action criteria are in `docs/operations.md`.

## Rollback

For the Traefik/GitHub Actions deployment, use the rollback process in
[`DEPLOY.md`](../DEPLOY.md). It records previous image tags, performs automatic
image rollback when deploy smoke checks fail and requires explicit confirmation
before restoring a database dump.

For a standalone Caddy deployment, keep release tags in GitHub and validate the
app after switching versions:

```bash
git checkout <previous-tag>
docker compose build app
docker compose up -d app
docker compose exec app wget -qO- http://localhost:3000/api/health
```

If the database must also be restored, validate the backup with
`pg_restore --list`, stop the app, restore with `pg_restore --clean --if-exists`
and only then start the app again. Destructive migrations require a tested
database rollback plan before release.
