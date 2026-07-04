#!/usr/bin/env bash
set -Eeuo pipefail

APP_PATH="${APP_PATH:-/mnt/storage/containers/expenses}"
MONITORING_PATH="${MONITORING_PATH:-/mnt/storage/containers/monitoring}"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose}"
PROMETHEUS_CONTAINER="${PROMETHEUS_CONTAINER:-monitoring-prometheus}"
NODE_TEXTFILE_DIR="${NODE_TEXTFILE_DIR:-${MONITORING_PATH}/node-exporter/textfile}"
APP_HEALTH_URL="${APP_HEALTH_URL:-}"
FAILURES=0
WARNINGS=0

note() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
warn() {
  WARNINGS=$((WARNINGS + 1))
  printf '[WARN] %s\n' "$*" >&2
}
fail() {
  FAILURES=$((FAILURES + 1))
  printf '[FAIL] %s\n' "$*" >&2
}

run_check() {
  local description="$1"
  shift
  if "$@" >/tmp/expense-manager-audit.out 2>/tmp/expense-manager-audit.err; then
    pass "${description}"
  else
    fail "${description}"
    sed -n '1,20p' /tmp/expense-manager-audit.err >&2 || true
  fi
}

compose_status() {
  local path="$1"
  local name="$2"
  if [ ! -d "${path}" ]; then
    warn "${name} path not found: ${path}"
    return 0
  fi
  (
    cd "${path}"
    ${COMPOSE_CMD} ps >/dev/null
    ${COMPOSE_CMD} config >/dev/null
  )
}

query_prometheus() {
  local query="$1"
  docker exec "${PROMETHEUS_CONTAINER}" wget -qO- \
    "http://127.0.0.1:9090/api/v1/query?query=${query}" |
    python3 -c 'import json,sys; p=json.load(sys.stdin); sys.exit(0 if p.get("status") == "success" and p.get("data", {}).get("result") else 1)'
}

query_no_firing_alerts() {
  docker exec "${PROMETHEUS_CONTAINER}" wget -qO- \
    http://127.0.0.1:9090/api/v1/alerts |
    python3 -c 'import json,sys; p=json.load(sys.stdin); alerts=[a for a in p.get("data", {}).get("alerts", []) if a.get("state") == "firing"]; [print(a.get("labels", {}).get("alertname", "unknown")) for a in alerts]; sys.exit(0 if not alerts else 1)'
}

get_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "${file}" ]; then
    return 1
  fi
  awk -F= -v key="${key}" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "${file}"
}

check_secret_permissions() {
  local secret_dir="$1"
  if [ ! -d "${secret_dir}" ]; then
    return 0
  fi
  local bad
  bad="$(find "${secret_dir}" -type f -perm -0007 -print -quit)"
  [ -z "${bad}" ]
}

check_no_public_monitoring_ports() {
  local bad
  bad="$(ss -ltn 2>/dev/null | awk '$4 ~ /(^0\\.0\\.0\\.0|^\\[::\\]):(3001|3002|3003|3004|9090|9093|3100|3200|4318|12345)$/ {print $4; exit}')"
  [ -z "${bad}" ]
}

check_textfile_metric() {
  local file="$1"
  [ -s "${NODE_TEXTFILE_DIR}/${file}" ]
}

main() {
  note "Running read-only production audit."
  run_check "application compose config is valid" compose_status "${APP_PATH}" "application"
  run_check "monitoring compose config is valid" compose_status "${MONITORING_PATH}" "monitoring"
  run_check "no failed systemd units" bash -c 'test "$(systemctl --failed --no-legend | wc -l)" -eq 0'
  run_check "Expense Manager timers are loaded" bash -c 'systemctl list-timers "expense-manager-*" --no-pager --no-legend | grep -q expense-manager'
  run_check "monitoring ports are not bound publicly" check_no_public_monitoring_ports

  if [ -d "${MONITORING_PATH}/secrets" ]; then
    run_check "monitoring secret files are not world-readable" check_secret_permissions "${MONITORING_PATH}/secrets"
  fi

  if docker ps --format '{{.Names}}' | grep -qx "${PROMETHEUS_CONTAINER}"; then
    run_check "Prometheus has no firing alerts" query_no_firing_alerts
    run_check "core monitoring targets are up" query_prometheus 'up%7Bjob%3D~%22node%7Ccadvisor%7Cprometheus%7Calertmanager%7Cloki%7Calloy%22%7D'
    run_check "application probes are present" query_prometheus 'probe_success%7Bapp%3D%22expenses%22%7D'
    run_check "backup metrics are present" query_prometheus '%7B__name__%3D~%22expense_manager_.*(backup%7Crestore_test%7Crestic_check).*_last_status%22%7D'
  else
    warn "Prometheus container is not running; skipping Prometheus queries."
  fi

  for metric_file in \
    expense_manager_nas_backup.prom \
    expense_manager_nas_restore_test.prom \
    expense_manager_monitoring_backup.prom \
    expense_manager_monitoring_restore_test.prom \
    expense_manager_nas_restic_check.prom \
    expense_manager_monitoring_restic_check.prom \
    expense_manager_recovery_drill.prom \
    expense_manager_post_reboot_healthcheck.prom \
    expense_manager_alert_fire_drill.prom; do
    run_check "textfile metric exists: ${metric_file}" check_textfile_metric "${metric_file}"
  done

  if [ -z "${APP_HEALTH_URL}" ]; then
    APP_HEALTH_URL="$(get_env_value "${APP_PATH}/.env" ORIGIN || true)"
    if [ -n "${APP_HEALTH_URL}" ]; then
      APP_HEALTH_URL="${APP_HEALTH_URL%/}/api/health"
    fi
  fi
  if [ -n "${APP_HEALTH_URL}" ]; then
    run_check "public application health is ok" python3 - "${APP_HEALTH_URL}" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url, timeout=15) as response:
    data = json.loads(response.read(65536).decode("utf-8"))
if response.status != 200 or data.get("ok") is not True or data.get("database") != "ok":
    raise SystemExit(1)
PY
  else
    warn "APP_HEALTH_URL is unset and ORIGIN was not found; skipping public health check."
  fi

  rm -f /tmp/expense-manager-audit.out /tmp/expense-manager-audit.err
  printf '[SUMMARY] failures=%s warnings=%s\n' "${FAILURES}" "${WARNINGS}"
  [ "${FAILURES}" -eq 0 ]
}

main "$@"
