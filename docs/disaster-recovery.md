# Disaster Recovery Runbook

This runbook is intentionally generic. Keep real hostnames, IPs, account names,
repository passwords and DNS provider details outside the public repository.

## Recovery Priorities

1. Preserve data: do not overwrite production Postgres or uploads until the
   backup snapshot and restore target are verified.
2. Restore private access first: SSH, Tailscale and Docker are prerequisites for
   safe recovery.
3. Prefer image rollback before database restore when the issue is an app
   deploy, configuration error or runtime crash.
4. Restore the database only when the current database is corrupt, lost or known
   to contain bad writes that must be discarded.

## Known Recovery Artifacts

Application:

```text
DEPLOY_PATH/.env
DEPLOY_PATH/docker-compose.yml
DEPLOY_PATH/backups/predeploy/
restic repository for application database/uploads
```

Monitoring:

```text
/mnt/storage/containers/monitoring/docker-compose.yml
/mnt/storage/containers/monitoring/secrets/
/mnt/storage/containers/monitoring/grafana/dashboards/
/root/.config/expense-manager-monitoring-backup/restic-password
restic repository for monitoring configuration and SQLite state
```

## Deploy Broke The App

Use image rollback first.

```bash
cd "$DEPLOY_PATH"

DEPLOY_PATH="$DEPLOY_PATH" \
COMPOSE_CMD="docker compose" \
bash scripts/rollback-vps.sh
```

Validate:

```bash
docker compose ps
docker compose logs --tail=120 app
curl -fsS "$ORIGIN/api/health"
```

Only restore a pre-deploy database dump if the new deployment ran a destructive
or incompatible migration and losing writes after deployment start is accepted.

## Database Is Corrupt Or Missing

1. Stop the app.
2. Restore the latest restic snapshot to a temporary directory.
3. Verify checksums and `pg_restore --list`.
4. Restore into Postgres during a maintenance window.
5. Start the app and run smoke tests.

Example:

```bash
cd "$DEPLOY_PATH"
docker compose stop app

mkdir -p restore
docker compose run --rm --no-deps \
  --entrypoint restic \
  -v "$PWD/restore:/restore" \
  backup restore latest --target /restore

sha256sum -c restore/path/from/restic/*.sha256
pg_restore --list restore/path/from/restic/expense_manager_YYYYMMDDTHHMMSSZ.dump >/dev/null

docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /restore/path/from/restic/expense_manager_YYYYMMDDTHHMMSSZ.dump

docker compose up -d app
curl -fsS "$ORIGIN/api/health"
```

## Uploads Are Missing

Restore the upload archive matching the same timestamp as the database restore
whenever possible.

```bash
cd "$DEPLOY_PATH"
mkdir -p restore

sha256sum -c restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz.sha256
tar -tzf restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz >/dev/null

docker compose run --rm --no-deps \
  -v "$PWD/restore:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
```

## Monitoring Stack Is Broken

If Grafana, Prometheus, Loki or Alertmanager break after an operational change:

```bash
cd /mnt/storage/containers/monitoring
docker compose config
docker compose ps
docker compose logs --tail=160 prometheus grafana loki alertmanager
```

If configuration/state must be restored:

```bash
mkdir -p /tmp/monitoring-restore

RESTIC_PASSWORD_FILE=/root/.config/expense-manager-monitoring-backup/restic-password \
restic -r sftp:<nas-ssh-alias>:/share/Backup/expense-manager-monitoring/restic \
  restore latest --target /tmp/monitoring-restore

find /tmp/monitoring-restore -name '*.sha256' -print0 |
  xargs -0 -I{} sh -c 'cd "$(dirname "{}")" && sha256sum -c "$(basename "{}")"'
```

Stop monitoring before copying restored state into place. Do not restore
Prometheus TSDB, Loki chunks or Tempo traces from this backup; they are
short-retention operational data.

## NAS Is Offline

The application should continue running on the VPS. Expected symptoms:

- NAS SSH/Tailscale probes fail.
- Backup timer fails or cannot reach the repository.
- Stale-backup alerts fire if the outage lasts beyond the backup window.
- NAS logs and NAS container metrics stop updating.

Actions:

1. Confirm the Expenses app is still healthy.
2. Do not disable backup alerts permanently.
3. When the NAS returns, run the backup and restore-test timers manually.

```bash
sudo systemctl start expense-manager-nas-backup.service
sudo systemctl start expense-manager-nas-restore-test.service
sudo systemctl start expense-manager-monitoring-backup.service
sudo systemctl start expense-manager-monitoring-restore-test.service
sudo systemctl start expense-manager-nas-restic-check.service
sudo systemctl start expense-manager-monitoring-restic-check.service
```

## VPS Is Lost

1. Provision a new VPS.
2. Restore private SSH/Tailscale access.
3. Install Docker.
4. Recreate the app deploy directory from the private deployment environment.
5. Restore Postgres and uploads from the remote restic repository.
6. Recreate monitoring from the monitoring restic repository.
7. Point DNS/Traefik to the new VPS.
8. Run production smoke checks.

The restic passwords must be recoverable from a private password manager or
another secure location. If a restic password exists only on the lost VPS, the
backup repository cannot be decrypted.

## Fire Drill Schedule

Run these checks after major infrastructure changes and at least quarterly:

- application image rollback without database restore;
- restore latest app backup into a temporary directory;
- restore-test timer for NAS backup;
- restore-test timer for monitoring backup;
- restic structural checks for app and monitoring repositories;
- alert delivery fire drill;
- post-reboot healthcheck after a planned reboot.
- quarterly recovery drill timer.

The non-destructive recovery drill can be run manually:

```bash
sudo systemctl start expense-manager-recovery-drill.service
sudo systemctl show expense-manager-recovery-drill.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_recovery_drill.prom
```

Record the result privately with date, operator, snapshot id and any corrective
actions. Do not commit private operational notes to the public repository.
