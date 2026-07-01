# VPS Deployment

## Requirements

- Docker Engine with Docker Compose
- `pnpm` does not need to be installed on the VPS; the Docker image installs dependencies during the build
- Domain pointed to the VPS
- Ports 80 and 443 open
- SMTP configured for password reset and invitations
- External storage for backup copies
- Persistent space for the `uploads` volume, used by receipt attachments

## Required Variables

- `APP_DOMAIN`
- `ORIGIN`
- `BETTER_AUTH_SECRET`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## Recommended Variables

- `UPLOAD_DIR`: attachment path inside the container. The compose file uses `/app/uploads` by default.
- `DB_POOL_MAX`: maximum application connection pool size.
- `TRUST_PROXY_HEADERS`: use `true` only when the app is not directly exposed and only receives traffic through a trusted reverse proxy. The default `docker-compose.yml` sets it to `true` because Caddy is the only published service.
- `TRUSTED_ORIGINS`: comma-separated extra origins for alternate URLs, VPN or Tailscale access. Use complete origins such as `https://finance.example.com` or `http://100.x.y.z:5173`.
- `BACKUP_OFFSITE_DIR`: optional path inside the backup container for copying already validated dumps and checksums. Mount this path to external storage according to your operating policy.
- `APP_MEM_LIMIT`, `APP_CPUS`, `POSTGRES_MEM_LIMIT`, `POSTGRES_CPUS`, `CADDY_MEM_LIMIT`, `BACKUP_MEM_LIMIT`: optional operational limits for tuning VPS resource usage.

## First Release

```bash
cp .env.example .env
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose up -d app caddy backup
```

The `backup` service writes Postgres dumps, `uploads_*.tar.gz` files for attachments and `.sha256` checksums. The dump is validated with `pg_restore --list`, and the uploads package is validated with `tar -tzf` before the optional copy to `BACKUP_OFFSITE_DIR`.

## Restore

Restore Postgres first:

```bash
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /path/to/backup.dump
```

Then restore the attachments matching the same dump timestamp:

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v "$(pwd)/backups:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
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

Keep release tags in GitHub. To roll back:

```bash
git checkout <previous-tag>
docker compose build app
docker compose up -d app
```

Destructive migrations require a database-specific rollback plan.
