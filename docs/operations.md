# Operations

## Postgres Observability

The compose setup loads `pg_stat_statements` and slow-query logs. For a manual diagnostic pass on the VPS, run:

```bash
docker compose exec -T postgres psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  < scripts/postgres-observability.sql
```

The script is read-only and covers:

- general database health, connections, cache hit rate, temporary files and deadlocks;
- long transactions and lock waits with blockers;
- most expensive queries by total and average time through `pg_stat_statements`;
- table and index sizes, scan mix, dead tuples and vacuum/analyze freshness;
- unused-index candidates, duplicate indexes and invalid indexes.

Do not remove indexes just because they appear unused in a new environment. Validate after real traffic, import jobs, reports and month-end usage. For a safer decision, compare:

```sql
explain (analyze, buffers)
select ...
```

before and after in a database copy or an operational maintenance window.

## Compose Hardening

The production `docker-compose.yml` runs the app as a non-root user, with a read-only filesystem, `/tmp` in `tmpfs`, dropped capabilities, `no-new-privileges`, basic CPU/memory limits and a real `/api/health` application healthcheck.

Caddy also uses a read-only filesystem and only keeps `NET_BIND_SERVICE`, which is required for publishing ports 80 and 443. Postgres stays more conservative because the official entrypoint needs to prepare the data volume with correct permissions.

Limits can be adjusted through environment variables without editing the compose file:

```bash
APP_MEM_LIMIT=768m
APP_CPUS=1.5
POSTGRES_MEM_LIMIT=2g
POSTGRES_CPUS=2
CADDY_MEM_LIMIT=256m
BACKUP_MEM_LIMIT=256m
```

After any operational change, validate the configuration:

```bash
docker compose config
docker compose up -d
docker compose ps
curl -fsS "$ORIGIN/api/health"
```

## Post-Deploy Smoke Test

Run the read-only smoke test after publishing a new version:

```bash
SMOKE_BASE_URL="$ORIGIN" pnpm test:smoke
```

The smoke suite checks `/api/health`, the login page and protected-route redirects. To also validate a real write path, use a disposable account or allow the suite to register one:

```bash
SMOKE_BASE_URL="$ORIGIN" SMOKE_WRITE_TESTS=true pnpm test:smoke
```

If the production environment requires pre-created credentials, provide them explicitly:

```bash
SMOKE_BASE_URL="$ORIGIN" \
SMOKE_WRITE_TESTS=true \
SMOKE_EMAIL="smoke@example.com" \
SMOKE_PASSWORD="replace-with-private-password" \
pnpm test:smoke
```

## Verifiable Backups

The backup job creates a custom Postgres dump, validates it with `pg_restore --list`, writes a `.sha256` checksum and repeats the same process for the attachment package when uploads exist. Configure `BACKUP_OFFSITE_DIR` only when that path is mounted on external storage or another persistent volume.

To manually validate a backup before restoring:

```bash
sha256sum -c /backups/expense_manager_YYYYMMDDTHHMMSSZ.dump.sha256
pg_restore --list /backups/expense_manager_YYYYMMDDTHHMMSSZ.dump >/dev/null
sha256sum -c /backups/uploads_YYYYMMDDTHHMMSSZ.tar.gz.sha256
tar -tzf /backups/uploads_YYYYMMDDTHHMMSSZ.tar.gz >/dev/null
```
