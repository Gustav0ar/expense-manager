#!/usr/bin/env bash
set -Eeuo pipefail

METRIC_DIR="${METRIC_DIR:-/mnt/storage/containers/monitoring/node-exporter/textfile}"
METRIC_FILE="${METRIC_FILE:-${METRIC_DIR}/expense_manager_recovery_drill.prom}"
APP_PATH="${APP_PATH:-/mnt/storage/containers/expenses}"
RUN_ALERT_FIRE_DRILL="${RUN_ALERT_FIRE_DRILL:-true}"
APP_HEALTH_URL="${APP_HEALTH_URL:-}"
started_at="$(date +%s)"
previous_success=0
checks_total=0
checks_failed=0
check_metrics=""

if [ -f "${METRIC_FILE}" ]; then
  previous_success="$(awk '$1 == "expense_manager_recovery_drill_last_success_timestamp_seconds" {print $2}' "${METRIC_FILE}" | tail -n 1)"
  previous_success="${previous_success:-0}"
fi

record_check() {
  local check_name="$1"
  local status="$2"
  checks_total=$((checks_total + 1))
  if [ "${status}" -ne 1 ]; then
    checks_failed=$((checks_failed + 1))
  fi
  check_metrics+="expense_manager_recovery_drill_check_status{check=\"${check_name}\"} ${status}"$'\n'
}

write_metrics() {
  local exit_code="$1"
  local finished_at duration status last_success tmp_metric
  finished_at="$(date +%s)"
  duration="$((finished_at - started_at))"
  status=0
  last_success="${previous_success}"
  if [ "${exit_code}" -eq 0 ] && [ "${checks_failed}" -eq 0 ]; then
    status=1
    last_success="${finished_at}"
  fi
  mkdir -p "${METRIC_DIR}"
  tmp_metric="$(mktemp "${METRIC_DIR}/.expense_manager_recovery_drill.XXXXXX")"
  cat >"${tmp_metric}" <<METRICS
# HELP expense_manager_recovery_drill_last_run_timestamp_seconds Unix timestamp of the last recovery drill attempt.
# TYPE expense_manager_recovery_drill_last_run_timestamp_seconds gauge
expense_manager_recovery_drill_last_run_timestamp_seconds ${finished_at}
# HELP expense_manager_recovery_drill_last_success_timestamp_seconds Unix timestamp of the last successful recovery drill.
# TYPE expense_manager_recovery_drill_last_success_timestamp_seconds gauge
expense_manager_recovery_drill_last_success_timestamp_seconds ${last_success}
# HELP expense_manager_recovery_drill_last_status Last recovery drill status, 1 for success and 0 for failure.
# TYPE expense_manager_recovery_drill_last_status gauge
expense_manager_recovery_drill_last_status ${status}
# HELP expense_manager_recovery_drill_last_duration_seconds Duration of the last recovery drill attempt.
# TYPE expense_manager_recovery_drill_last_duration_seconds gauge
expense_manager_recovery_drill_last_duration_seconds ${duration}
# HELP expense_manager_recovery_drill_checks_total Number of checks executed by the last recovery drill.
# TYPE expense_manager_recovery_drill_checks_total gauge
expense_manager_recovery_drill_checks_total ${checks_total}
# HELP expense_manager_recovery_drill_checks_failed Number of checks failed by the last recovery drill.
# TYPE expense_manager_recovery_drill_checks_failed gauge
expense_manager_recovery_drill_checks_failed ${checks_failed}
# HELP expense_manager_recovery_drill_check_status Individual recovery drill check status, 1 for success and 0 for failure.
# TYPE expense_manager_recovery_drill_check_status gauge
METRICS
  printf "%s" "${check_metrics}" >>"${tmp_metric}"
  chmod 0644 "${tmp_metric}"
  mv "${tmp_metric}" "${METRIC_FILE}"
}

finish() {
  local exit_code="$?"
  write_metrics "${exit_code}" || true
  if [ "${checks_failed}" -gt 0 ]; then
    exit 1
  fi
  exit "${exit_code}"
}
trap finish EXIT INT TERM

run_unit() {
  local check_name="$1"
  local unit="$2"
  if systemctl start "${unit}" >/dev/null 2>&1 &&
    [ "$(systemctl show "${unit}" -p Result --value 2>/dev/null)" = "success" ] &&
    [ "$(systemctl show "${unit}" -p ExecMainStatus --value 2>/dev/null)" = "0" ]; then
    record_check "${check_name}" 1
  else
    record_check "${check_name}" 0
  fi
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

run_unit app_restore_test expense-manager-nas-restore-test.service
run_unit monitoring_restore_test expense-manager-monitoring-restore-test.service
run_unit post_reboot_healthcheck expense-manager-post-reboot-healthcheck.service

if [ "${RUN_ALERT_FIRE_DRILL}" = "true" ]; then
  run_unit alert_fire_drill expense-manager-alert-fire-drill.service
fi

if [ -z "${APP_HEALTH_URL}" ]; then
  origin="$(get_env_value "${APP_PATH}/.env" ORIGIN || true)"
  if [ -n "${origin}" ]; then
    APP_HEALTH_URL="${origin%/}/api/health"
  fi
fi

if [ -n "${APP_HEALTH_URL}" ] && python3 - "${APP_HEALTH_URL}" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url, timeout=15) as response:
    data = json.loads(response.read(65536).decode("utf-8"))
if response.status != 200 or data.get("ok") is not True or data.get("database") != "ok":
    raise SystemExit(1)
PY
then
  record_check public_health 1
else
  record_check public_health 0
fi

echo "recovery_drill_checks=${checks_total} failed=${checks_failed}"
