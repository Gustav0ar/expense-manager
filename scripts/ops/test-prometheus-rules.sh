#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMETHEUS_DIR="${ROOT_DIR}/monitoring/prometheus"
IMAGE="${PROMTOOL_IMAGE:-docker.io/prom/prometheus:v3.13.0}"

if command -v promtool >/dev/null 2>&1; then
  (
    cd "${PROMETHEUS_DIR}"
    promtool test rules "tests/expense-manager-alerts.test.yml"
  )
  exit 0
fi

engine="${CONTAINER_ENGINE:-}"
if [ -z "${engine}" ]; then
  if command -v docker >/dev/null 2>&1; then
    engine="docker"
  elif command -v podman >/dev/null 2>&1; then
    engine="podman"
  else
    echo "promtool, docker or podman is required to run Prometheus rule tests." >&2
    exit 127
  fi
fi

"${engine}" run --rm \
  --entrypoint promtool \
  --workdir /work \
  -v "${PROMETHEUS_DIR}:/work:ro" \
  "${IMAGE}" \
  test rules tests/expense-manager-alerts.test.yml
