# Operations

## Monitoring Access

The production monitoring stack is separate from the application stack and must
stay private to the tailnet. Do not publish these services through public
Traefik routers.

Use these private endpoints from a device connected to the tailnet:

```text
Grafana: http://<tailscale-ip>:3002
Uptime Kuma: http://<tailscale-ip>:3001
Dozzle logs: http://<tailscale-ip>:3003
Dockge compose management: http://<tailscale-ip>:3004
NAS Dozzle logs: http://<nas-tailscale-ip>:3003
```

Generated admin passwords stay only on the VPS:

```text
/mnt/storage/containers/monitoring/secrets/grafana_admin_password
/mnt/storage/containers/monitoring/secrets/dozzle_admin_password
/mnt/storage/containers/monitoring/secrets/dockge_admin_password
```

NAS management passwords should stay only on the NAS, for example:

```text
/share/Container/management/secrets/dozzle_admin_password
```

Useful dashboards:

- `Container Monitoring`: container CPU, memory, filesystem and network usage.
- `Docker Logs`: recent Docker logs from Loki, filterable by Compose project and
  service.
- `Operations Alerts`: Prometheus probe, scrape and alert-state overview.
- Expense app dashboard: application health, synthetic checks and traces.
- `Home Infra`: single overview for the Expenses app, NAS backup freshness, NAS
  disk usage, NAS reachability, restore tests, alerts and recent NAS Docker
  logs.
- `Capacity Planning`: VPS/NAS CPU, memory and storage trends, backup age,
  monitoring target failures and container restart trends.

## Logs, Metrics And Traces

The lightweight production pipeline is:

```text
Docker logs -> Grafana Alloy -> Grafana Loki -> Grafana
NAS Docker logs -> NAS Grafana Alloy -> VPS Grafana Loki -> Grafana
Container metrics -> cAdvisor -> Prometheus -> Grafana
NAS container metrics -> NAS cAdvisor -> VPS Prometheus -> Grafana
Host metrics -> node_exporter -> Prometheus -> Grafana
NAS host metrics -> NAS node_exporter -> VPS Prometheus -> Grafana
HTTP probes -> blackbox_exporter -> Prometheus -> Grafana
App traces -> Tempo -> Grafana
Prometheus alerts -> Alertmanager -> Telegram webhook -> Telegram
```

The VPS is the monitoring control plane. Grafana, Prometheus, Loki,
Alertmanager and Telegram notification stay on the VPS because it is the more
stable machine. The NAS should only run lightweight agents/exporters that expose
or push data over the private tailnet.

Loki uses local filesystem storage with short retention. It is for operational
debugging, not long-term audit storage.

Default log retention policy:

- Loki deletes logs older than `168h` (`7` days).
- Expense application logs can use a longer stream-specific Loki retention, for
  example `336h` (`14` days), while infrastructure/container logs stay at the
  shorter default.
- Alloy drops Docker log lines older than `168h` before forwarding.
- Compose-managed monitoring containers use Docker `json-file` rotation with
  `max-size=10m` and `max-file=3`.
- Existing NAS containers created outside this management compose are not
  forcibly recreated just to change Docker log options. Apply log rotation to
  them during planned maintenance if needed.

Validate the monitoring stack from the VPS:

```bash
cd /mnt/storage/containers/monitoring

docker compose ps
docker compose logs --tail=120 loki alloy prometheus grafana

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'up{job=~"alertmanager|cadvisor|loki|alloy|node|prometheus|nas_node|nas_cadvisor|nas_alloy"}'

docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS http://loki:3100/loki/api/v1/labels
```

Query recent Docker logs through Loki:

```bash
docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS -G http://loki:3100/loki/api/v1/query \
  --data-urlencode 'query=sum(count_over_time({source="docker"}[15m]))'
```

Query recent NAS Docker logs through Loki:

```bash
docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS -G http://loki:3100/loki/api/v1/query \
  --data-urlencode 'query=sum(count_over_time({host="gus-nas",source="docker"}[15m]))'
```

## Alerting

Prometheus alert rules are provisioned in the monitoring stack. They cover:

- public app availability;
- public and internal `/api/health`;
- authenticated synthetic browser flow;
- high host memory usage;
- high root filesystem usage;
- high application storage usage;
- cAdvisor scrape health;
- Loki/Alloy scrape health;
- Alertmanager scrape health;
- container restart loops.
- NAS host exporter and container metrics scrape health;
- NAS CPU, memory and filesystem usage;
- NAS container restart loops.
- encrypted NAS backup freshness and restore-test freshness;
- encrypted monitoring-stack backup freshness and restore-test freshness;
- weekly alert delivery fire drill freshness;
- post-reboot healthcheck status;
- public DNS probe status;
- TLS certificate expiry;
- Traefik presence and restart loops.

Alertmanager groups notifications by `service` and `severity`, uses shorter
repeat intervals for critical alerts and inhibits lower-severity cascades when a
critical alert for the same service is already active. A critical Traefik alert
also inhibits lower-severity Expense Manager public-route alerts because those
are usually symptoms of the ingress outage.

Validate rule loading:

```bash
cd /mnt/storage/containers/monitoring

docker run --rm --entrypoint promtool \
  -v "$PWD/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$PWD/prometheus/rules:/etc/prometheus/rules:ro" \
  prom/prometheus:v3.13.0 \
  check config /etc/prometheus/prometheus.yml
```

When alert rules change in this repository, run the rule behavior tests before
deploying the equivalent production rules:

```bash
scripts/ops/test-prometheus-rules.sh
```

The script uses local `promtool` when available, otherwise it runs the official
Prometheus container through Docker or Podman.

Telegram notification is handled by Alertmanager and a private internal webhook
service. The webhook reads these VPS-only secret files:

```text
/mnt/storage/containers/monitoring/secrets/telegram_bot_token
/mnt/storage/containers/monitoring/secrets/telegram_chat_id
```

Do not commit these values or copy them into docs. If a token is pasted into a
chat, ticket or terminal transcript, rotate it at the provider and replace the
VPS secret file.

Validate Alertmanager and the Telegram webhook from the VPS:

```bash
cd /mnt/storage/containers/monitoring

docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS http://alertmanager:9093/-/ready

docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS http://telegram-alerts:8080/health
```

Run the controlled alert fire drill after changing alerting or notification
configuration:

```bash
sudo systemctl start expense-manager-alert-fire-drill.service
sudo systemctl status expense-manager-alert-fire-drill.service --no-pager -l
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_alert_fire_drill.prom
```

The weekly timer keeps a freshness metric so silence becomes visible:

```bash
systemctl list-timers expense-manager-alert-fire-drill.timer --no-pager
```

For ad-hoc manual testing without the systemd helper, post a temporary alert to
Alertmanager:

```bash
cd /mnt/storage/containers/monitoring

docker run -i --rm --network monitoring_default python:3.13-alpine python - <<'PY'
import json
import urllib.request
from datetime import datetime, timedelta, timezone

starts_at = datetime.now(timezone.utc).replace(microsecond=0)
ends_at = starts_at + timedelta(minutes=2)

payload = [{
    "labels": {
        "alertname": "SyntheticFireDrill",
        "severity": "warning",
        "service": "monitoring",
    },
    "annotations": {
        "summary": "Synthetic monitoring fire drill",
        "description": "Safe test alert sent through Alertmanager.",
    },
    "startsAt": starts_at.isoformat().replace("+00:00", "Z"),
    "endsAt": ends_at.isoformat().replace("+00:00", "Z"),
    "generatorURL": "http://manual-fire-drill.local/",
}]

request = urllib.request.Request(
    "http://alertmanager:9093/api/v2/alerts",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=10) as response:
    print(response.status)
PY

docker compose logs --since=2m alertmanager telegram-alerts
```

The webhook logs should confirm delivery without printing the bot token.

## Monitoring Stack Backups

Back up the monitoring control plane separately from the application database.
The monitoring backup should be small and should not upload Prometheus TSDB,
Loki chunks or Tempo trace storage. It should include:

- monitoring compose/configuration files;
- Grafana dashboards and provisioning files;
- SQLite backups for Grafana, Uptime Kuma and Dockge state;
- checksums for every restored artifact.

Recommended VPS layout:

```text
/usr/local/sbin/expense-manager-monitoring-backup
/usr/local/sbin/expense-manager-monitoring-restore-test
/etc/systemd/system/expense-manager-monitoring-backup.service
/etc/systemd/system/expense-manager-monitoring-backup.timer
/etc/systemd/system/expense-manager-monitoring-restore-test.service
/etc/systemd/system/expense-manager-monitoring-restore-test.timer
/root/.config/expense-manager-monitoring-backup/restic-password
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_backup.prom
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_restore_test.prom
```

Manual validation:

```bash
sudo systemctl start expense-manager-monitoring-backup.service
sudo systemctl show expense-manager-monitoring-backup.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_backup.prom

sudo systemctl start expense-manager-monitoring-restore-test.service
sudo systemctl show expense-manager-monitoring-restore-test.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_restore_test.prom
```

Validate encrypted snapshots:

```bash
RESTIC_PASSWORD_FILE=/root/.config/expense-manager-monitoring-backup/restic-password \
restic -r sftp:<nas-ssh-alias>:/share/Backup/expense-manager-monitoring/restic snapshots
```

The restore-test timer must run in a temporary directory and must not overwrite
production monitoring state.

## Restic Repository Checks

Restore tests prove that the latest backup artifacts can be read. A periodic
`restic check` adds a structural validation of the encrypted repository itself.
Run it at low frequency because it can be more expensive than a normal restore
test on small VPS/NAS hosts.

Recommended timers:

```text
/usr/local/sbin/expense-manager-restic-check
/etc/systemd/system/expense-manager-nas-restic-check.service
/etc/systemd/system/expense-manager-nas-restic-check.timer
/etc/systemd/system/expense-manager-monitoring-restic-check.service
/etc/systemd/system/expense-manager-monitoring-restic-check.timer
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_restic_check.prom
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_restic_check.prom
```

Manual run:

```bash
sudo systemctl start expense-manager-nas-restic-check.service
sudo systemctl show expense-manager-nas-restic-check.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_restic_check.prom

sudo systemctl start expense-manager-monitoring-restic-check.service
sudo systemctl show expense-manager-monitoring-restic-check.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_monitoring_restic_check.prom
```

Timer status:

```bash
systemctl list-timers 'expense-manager-*restic-check*' --no-pager
```

Prometheus should alert when the latest check fails or when no successful check
has completed within the accepted window.

## Post-Reboot Healthcheck

Run a post-reboot healthcheck after Docker and networking are online. It should
validate at least:

- Docker daemon readiness;
- the Expenses app container and `/api/health`;
- key monitoring containers;
- public `/api/health`;
- Prometheus scrape status for VPS and NAS targets;
- NAS SSH/SFTP reachability over the tailnet;
- Traefik container presence.

Manual run:

```bash
sudo systemctl start expense-manager-post-reboot-healthcheck.service
sudo systemctl show expense-manager-post-reboot-healthcheck.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_post_reboot_healthcheck.prom
```

Timer status:

```bash
systemctl list-timers expense-manager-post-reboot-healthcheck.timer --no-pager
```

The timer usually has no next run after boot. That is expected; it runs again on
the next host boot and can be triggered manually during maintenance.

## DNS, TLS And Traefik Monitoring

Public app probes should cover more than HTTP status:

- public page availability;
- public `/api/health`;
- public DNS resolution through blackbox exporter DNS probe;
- TLS certificate expiry through `probe_ssl_earliest_cert_expiry`;
- Traefik container presence and restart loops through cAdvisor.

Useful validation queries:

```bash
docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'probe_success{app="expenses",check=~"public_site|public_health|public_dns"}'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  '(probe_ssl_earliest_cert_expiry{app="expenses"} - time()) / 86400'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'container_last_seen{job="cadvisor",name="traefik"}'
```

Do not expose Prometheus, Alertmanager, Loki, Tempo or the blackbox exporter
through public Traefik routes. Use Grafana over the tailnet for inspection.

## Container Management

Dockge can manage every Compose project under the configured stacks directory.
Because it has read-write Docker socket access, treat it as equivalent to root
administration of the VPS:

- access it only through Tailscale;
- use a strong generated admin password;
- do not expose it through public Traefik routes;
- avoid enabling embedded terminal/console features unless needed;
- verify `docker compose ls` before stopping or recreating services.

Dozzle and Alloy should use the internal Docker socket proxy instead of mounting
the Docker socket directly. Keep shell/actions disabled unless you intentionally
need them, and prefer Dockge or direct SSH for changes. Dockge still needs
read-write Docker socket access because it manages Compose projects.

Validate that only the intended monitoring ports are published on the Tailscale
interface and that Prometheus, Loki, Tempo, Alloy and Alertmanager remain
private to Docker networks:

```bash
sudo ss -ltnp | grep -E ':(3001|3002|3003|3004)\b'
sudo ss -ltnp | grep -E ':(9090|9093|3100|3200|4318|12345)\b' || true
```

The first command should show the private monitoring UI ports. The second
command should normally return nothing unless you intentionally exposed a
service for maintenance.

## Production Audit

Run the read-only audit after infrastructure changes, before planned reboots and
after major deployments:

```bash
sudo /usr/local/sbin/expense-manager-production-audit
```

The repository copy is [`../scripts/ops/audit-production.sh`](../scripts/ops/audit-production.sh).
It checks compose validity, failed systemd units, monitoring port exposure,
secret file permissions, Prometheus alert state, expected textfile metrics and
public application health. It must not print secrets.

## Host Security Updates

Enable unattended Ubuntu security updates on the VPS, but keep automatic reboots
disabled unless you have a separate maintenance policy:

```bash
sudo apt-get update
sudo apt-get install -y unattended-upgrades apt-listchanges
sudo systemctl enable --now unattended-upgrades
```

Recommended behavior:

- update package lists daily;
- apply security-only updates daily;
- remove unused dependencies automatically;
- do not reboot automatically.

Validate status:

```bash
systemctl is-active unattended-upgrades
apt-config dump | grep -E 'APT::Periodic|Unattended-Upgrade::Automatic-Reboot'
```

After kernel or runtime security updates, schedule a manual reboot and confirm
that all Compose projects return healthy.

## Storage Growth

Monitor both the root filesystem and the application storage mount. The alerting
rules should include `/` and the directory that stores Compose data, databases,
uploads and monitoring state.

Manual checks:

```bash
df -h /
df -h /mnt/storage
docker system df
du -xh /mnt/storage/containers --max-depth=2 | sort -h | tail -30
```

Do not run global Docker prune commands on a shared VPS unless you have checked
all Compose projects and confirmed no other application depends on the images,
volumes or build cache being removed.

Expense Manager deploys perform scoped image cleanup after successful deploys
and manual rollbacks. The cleanup removes only old local tags for:

- `expense-manager-app`;
- `expense-manager-migrate`;
- `expense-manager-backup`.

It keeps the active image tag, previous image tag, last successful tag, last
rollback tag and `latest`. It does not run `docker system prune`, does not
remove unrelated images and does not remove Docker volumes. Set
`IMAGE_CLEANUP_ENABLED=false` in the private production environment only when
you intentionally need to retain old local image tags for investigation.

## NAS Backups

For a private NAS connected through the same tailnet, use encrypted restic over
SFTP instead of raw database dumps:

```text
VPS -> Tailscale -> NAS SSH/SFTP -> /share/Backup/expense-manager/restic
```

Recommended VPS layout:

```text
/usr/local/sbin/expense-manager-nas-backup
/etc/systemd/system/expense-manager-nas-backup.service
/etc/systemd/system/expense-manager-nas-backup.timer
/etc/systemd/system/expense-manager-nas-metrics.service
/etc/systemd/system/expense-manager-nas-metrics.timer
/etc/systemd/system/expense-manager-nas-restore-test.service
/etc/systemd/system/expense-manager-nas-restore-test.timer
/root/.ssh/<nas-backup-ssh-key>
/root/.config/expense-manager-nas-backup/restic-password
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_backup.prom
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas.prom
/mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_restore_test.prom
```

The backup script should:

- create a PostgreSQL custom-format dump with `pg_dump -Fc`;
- validate the dump with `pg_restore --list`;
- archive the uploads Docker volume when it exists;
- create SHA-256 checksum files;
- upload artifacts to restic over SFTP;
- run restic retention with daily, weekly and monthly policies;
- update node_exporter textfile metrics for Prometheus alerts.

Manual run:

```bash
sudo systemctl start expense-manager-nas-backup.service
sudo systemctl status expense-manager-nas-backup.service --no-pager -l
journalctl -u expense-manager-nas-backup.service -n 120 --no-pager
```

The backup service should retry automatically on failure:

```text
Restart=on-failure
RestartSec=30min
StartLimitIntervalSec=8h
StartLimitBurst=4
```

This handles short NAS outages without waiting for the next daily timer. A
longer outage should still alert through stale-backup rules.

Timer status:

```bash
systemctl list-timers expense-manager-nas-backup.timer --no-pager
systemctl list-timers 'expense-manager-nas-*' --no-pager
systemctl show expense-manager-nas-backup.service -p Result -p ExecMainStatus
```

Validate metrics:

```bash
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_backup.prom
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas.prom
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_nas_restore_test.prom

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'expense_manager_nas_backup_last_status'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'time() - expense_manager_nas_backup_last_success_timestamp_seconds'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'expense_manager_nas_backup_filesystem_used_percent'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'expense_manager_nas_restore_test_last_status'
```

Validate restic snapshots from the VPS:

```bash
RESTIC_PASSWORD_FILE=/root/.config/expense-manager-nas-backup/restic-password \
restic -r sftp:<nas-ssh-alias>:/share/Backup/expense-manager/restic snapshots
```

Restore test without touching production:

```bash
mkdir -p /tmp/expense-manager-restore-test

RESTIC_PASSWORD_FILE=/root/.config/expense-manager-nas-backup/restic-password \
restic -r sftp:<nas-ssh-alias>:/share/Backup/expense-manager/restic \
  restore latest --target /tmp/expense-manager-restore-test

find /tmp/expense-manager-restore-test -name '*.dump' -print -quit |
  xargs -r -I{} docker run --rm -v "$(dirname "{}"):/restore:ro" \
    postgres:18-alpine pg_restore --list "/restore/$(basename "{}")"
```

The weekly restore test timer automates this validation against the latest
snapshot and updates textfile metrics:

```bash
sudo systemctl start expense-manager-nas-restore-test.service
sudo systemctl status expense-manager-nas-restore-test.service --no-pager -l
```

Production restore should remain manual. Stop the app first, validate the dump
and checksum, then restore into Postgres during a maintenance window.

Prometheus should alert on:

- failed last NAS backup attempt;
- last successful NAS backup older than the accepted window;
- missing backup metrics;
- failed or stale restore tests;
- failed or stale restic structural checks;
- high NAS backup filesystem usage;
- NAS SSH unreachable over Tailscale;
- NAS Dozzle unreachable over Tailscale.
- NAS log collector unreachable over Tailscale.

If the NAS loses power, the application should continue running on the VPS. The
expected behavior is a failed backup attempt and a stale-backup alert if the NAS
does not return before the alert window.

## NAS Container Management

Keep NAS management separate from VPS management unless you intentionally expose
remote Docker APIs. A lightweight setup is:

- keep the existing NAS manager for containers it already owns;
- run Dozzle on the NAS, bound only to the NAS tailnet IP, for container logs;
- keep shell/actions disabled in Dozzle;
- use Dockge only for new Compose stacks or after a planned migration from the
  existing NAS manager.

Dozzle on the NAS should mount the Docker socket read-only and keep the user
file outside the public repository:

```text
/share/Container/management/docker-compose.yml
/share/Container/management/dozzle/data/users.yml
/share/Container/management/secrets/dozzle_admin_password
/share/Container/management/alloy/config.alloy
```

Validate from a tailnet device:

```bash
curl -fsSI http://<nas-tailscale-ip>:3003/ || true
```

An HTTP redirect to the login page is acceptable; the important point is that
the endpoint is reachable only through the private tailnet.

NAS Alloy should publish only its metrics port on the NAS tailnet IP and push
Docker logs to the VPS Loki endpoint bound to the VPS tailnet IP. Keep Loki
unpublished publicly; binding it to the tailnet IP is only for private log
ingestion from the NAS.

NAS node_exporter and cAdvisor should also bind only to the NAS tailnet IP:

```text
NAS node_exporter: http://<nas-tailscale-ip>:9100
NAS cAdvisor: http://<nas-tailscale-ip>:8081
NAS Alloy metrics: http://<nas-tailscale-ip>:12345
NAS Dozzle logs: http://<nas-tailscale-ip>:3003
```

Use low scrape/collection intervals on the NAS because QNAP-class CPUs are often
modest. A practical baseline is 60s cAdvisor housekeeping and 60s Prometheus
scrape for NAS container metrics.

Validate NAS log collection from the VPS:

```bash
docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'up{job="nas_alloy"}'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'up{job=~"nas_node|nas_cadvisor"}'

docker exec monitoring-prometheus promtool query instant \
  http://127.0.0.1:9090 \
  'count(container_last_seen{job="nas_cadvisor",name!=""})'

docker run --rm --network monitoring_default curlimages/curl:8.11.1 \
  -fsS -G http://loki:3100/loki/api/v1/query \
  --data-urlencode 'query=sum(count_over_time({host="gus-nas",source="docker"}[5m]))'
```

## Tailscale ACLs

Tailscale ACLs are configured at the tailnet level, not from the VPS or NAS over
SSH. Use [`tailscale-acl.example.hujson`](tailscale-acl.example.hujson) as a
starting point and apply it in the Tailscale admin console or API after
replacing the example users and tags.

The intended policy is:

- admin devices can access private management UIs;
- the VPS can reach the NAS SSH/SFTP port for encrypted backup;
- the VPS can scrape NAS Dozzle/Alloy health over the tailnet;
- the NAS can push logs only to the VPS Loki tailnet endpoint;
- no monitoring service is exposed through public DNS or public Traefik routes.

The example ACL includes `tests`. Keep those tests when applying the policy so
future ACL edits prove that management ports remain private and NAS/VPS flows
stay narrowly scoped.

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

## Recovery Drill

The recovery drill chains the non-destructive operational checks that prove the
system can be recovered without touching production data:

- application backup restore test;
- monitoring backup restore test;
- post-reboot healthcheck;
- alert delivery fire drill;
- public `/api/health`.

Manual run:

```bash
sudo systemctl start expense-manager-recovery-drill.service
sudo systemctl show expense-manager-recovery-drill.service -p Result -p ExecMainStatus
cat /mnt/storage/containers/monitoring/node-exporter/textfile/expense_manager_recovery_drill.prom
```

Timer status:

```bash
systemctl list-timers expense-manager-recovery-drill.timer --no-pager
```

The repository copy is [`../scripts/ops/recovery-drill.sh`](../scripts/ops/recovery-drill.sh).
It is intentionally non-destructive and should restore only into temporary
directories through the existing restore-test services.

## Rollback

Use [`DEPLOY.md`](../DEPLOY.md) as the rollback runbook for Traefik/GitHub
Actions deployments. The deploy script automatically rolls app containers back
to the previous image tag when migrations, container restart, healthcheck or
public smoke checks fail.

Database restore is intentionally separate. Only restore a dump when you have
confirmed that losing writes after the deployment start is acceptable, and use
the `restore-database` confirmation required by `scripts/rollback-vps.sh`.

Use [`disaster-recovery.md`](disaster-recovery.md) for broader scenarios such
as a lost VPS, offline NAS, broken monitoring state or full database/uploads
restore.

## Verifiable Backups

The backup job creates a temporary custom Postgres dump, validates it with `pg_restore --list`, writes a `.sha256` checksum and repeats the same process for the attachment package when uploads exist. It then uploads everything to the encrypted remote `RESTIC_REPOSITORY` and removes local temporary files.

To inspect remote snapshots:

```bash
docker compose run --rm --no-deps --entrypoint restic backup snapshots
```

To manually validate restored files before applying them:

```bash
sha256sum -c restore/path/from/restic/expense_manager_YYYYMMDDTHHMMSSZ.dump.sha256
pg_restore --list restore/path/from/restic/expense_manager_YYYYMMDDTHHMMSSZ.dump >/dev/null
sha256sum -c restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz.sha256
tar -tzf restore/path/from/restic/uploads_YYYYMMDDTHHMMSSZ.tar.gz >/dev/null
```
