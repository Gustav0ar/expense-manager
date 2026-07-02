#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/expense-manager}"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose}"
TARGET_IMAGE_TAG="${IMAGE_TAG:-}"
RESTORE_DATABASE_BACKUP="${RESTORE_DATABASE_BACKUP:-}"
CONFIRM_DATABASE_RESTORE="${CONFIRM_DATABASE_RESTORE:-}"
ROLLBACK_COMPOSE_SHA="${ROLLBACK_COMPOSE_SHA:-}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

read -r -a COMPOSE_ARGS <<< "${COMPOSE_CMD}"
if [ "${#COMPOSE_ARGS[@]}" -eq 0 ]; then
	echo "COMPOSE_COMMAND is empty"
	exit 1
fi
if ! command -v "${COMPOSE_ARGS[0]}" >/dev/null 2>&1; then
	echo "Container CLI not found: ${COMPOSE_ARGS[0]}"
	exit 1
fi
CONTAINER_CLI="${COMPOSE_ARGS[0]}"
if [ "${CONTAINER_CLI}" = "docker-compose" ]; then
	CONTAINER_CLI="docker"
fi

echo "::group::Rollback expense-manager"
echo "Compose command: ${COMPOSE_CMD}"
echo "Deploy path    : ${DEPLOY_PATH}"
echo "::endgroup::"

cd "${DEPLOY_PATH}"

if [ ! -f .env ]; then
	echo ".env is missing in ${DEPLOY_PATH}; rollback cannot continue."
	exit 1
fi
chmod 600 .env

dump_compose_diagnostics() {
	echo "::group::Compose diagnostics"
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile tools --profile backup ps || true
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile tools --profile backup logs --no-color --tail=160 app postgres migrate backup || true
	echo "::endgroup::"
}

fail_with_diagnostics() {
	dump_compose_diagnostics
	exit 1
}

upsert_env_var() {
	key="$1"
	value="$2"
	tmp_file="$(mktemp)"
	grep -v -E "^${key}=" .env > "${tmp_file}" || true
	printf '%s=%s\n' "${key}" "${value}" >> "${tmp_file}"
	cat "${tmp_file}" > .env
	rm -f "${tmp_file}"
}

read_env_var() {
	key="$1"
	grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- | sed -E 's/^"//; s/"$//' || true
}

backup_enabled() {
	case "$(read_env_var BACKUP_ENABLED | tr '[:upper:]' '[:lower:]')" in
		"" | true | 1 | yes | on) return 0 ;;
		false | 0 | no | off) return 1 ;;
		*)
			echo "BACKUP_ENABLED must be true or false."
			exit 1
			;;
	esac
}

wait_for_container_health() {
	container="$1"
	label="$2"
	for _ in $(seq 1 45); do
		status="$("${CONTAINER_CLI}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck:{{.State.Status}}{{end}}' "${container}" 2>/dev/null || true)"
		if [ "${status}" = "healthy" ]; then
			echo "${label} healthy"
			return 0
		fi
		if [[ "${status}" == missing-healthcheck:* ]]; then
			echo "${label} has no container healthcheck: ${status#missing-healthcheck:}"
			return 1
		fi
		if [ "${status}" = "unhealthy" ] || [ "${status}" = "exited" ] || [ "${status}" = "dead" ]; then
			echo "${label} failed with container status: ${status}"
			return 1
		fi
		sleep 2
	done
	echo "${label} did not become healthy in time"
	return 1
}

curl_public_route() {
	domain="$1"
	path="$2"
	label="$3"
	url="https://${domain}${path}"
	attempts="${PUBLIC_ROUTE_RETRIES:-12}"
	delay_seconds="${PUBLIC_ROUTE_RETRY_DELAY_SECONDS:-5}"

	for attempt in $(seq 1 "${attempts}"); do
		if curl --fail --silent --max-time 15 \
			--resolve "${domain}:443:127.0.0.1" \
			-o /dev/null \
			"${url}"; then
			echo "${label} public route responded through local Traefik"
			return 0
		fi

		if curl --fail --silent --max-time 15 \
			-o /dev/null \
			"${url}"; then
			echo "${label} public route responded through DNS"
			return 0
		fi

		if [ "${attempt}" -lt "${attempts}" ]; then
			echo "${label} public route not ready yet; retrying in ${delay_seconds}s (${attempt}/${attempts})"
			sleep "${delay_seconds}"
		fi
	done

	echo "${label} public route did not respond after ${attempts} attempts"
	return 1
}

verify_public_routes() {
	domain="$(read_env_var DOMAIN_NAME)"
	if [ -z "${domain}" ]; then
		echo "DOMAIN_NAME is missing; skipping public route checks."
		return 0
	fi

	curl_public_route "${domain}" "/api/health" "Application health" &&
		curl_public_route "${domain}" "/" "Application root"
}

fetch_repo_file() {
	remote_path="$1"
	local_path="$2"
	if [ -z "${GITHUB_REPOSITORY}" ]; then
		echo "GITHUB_REPOSITORY is required when ROLLBACK_COMPOSE_SHA is set."
		exit 1
	fi

	mkdir -p "$(dirname "${local_path}")"
	curl -fsSL "${curl_headers[@]}" \
		-o "${local_path}" \
		"https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${ROLLBACK_COMPOSE_SHA}/${remote_path}"
}

restore_database_backup() {
	if [ -z "${RESTORE_DATABASE_BACKUP}" ]; then
		return 0
	fi

	if [ "${CONFIRM_DATABASE_RESTORE}" != "restore-database" ]; then
		echo "Database restore was requested, but CONFIRM_DATABASE_RESTORE is not 'restore-database'."
		exit 1
	fi

	case "${RESTORE_DATABASE_BACKUP}" in
		/*) backup_file="${RESTORE_DATABASE_BACKUP}" ;;
		*) backup_file="${DEPLOY_PATH}/${RESTORE_DATABASE_BACKUP}" ;;
	esac

	if [ ! -f "${backup_file}" ]; then
		echo "Database backup not found: ${backup_file}"
		exit 1
	fi

	if [ -f "${backup_file}.sha256" ]; then
		echo "Validating database backup checksum."
		if ! (cd "${DEPLOY_PATH}" && sha256sum -c "${backup_file}.sha256"); then
			echo "Database backup checksum validation failed."
			exit 1
		fi
	else
		echo "No .sha256 file found for ${backup_file}; continuing after pg_restore validation."
	fi

	echo "Validating database backup format."
	if ! "${CONTAINER_CLI}" run --rm -i -v "$(dirname "${backup_file}"):/restore:ro" postgres:18-alpine \
		pg_restore --list "/restore/$(basename "${backup_file}")" >/dev/null; then
		echo "Database backup format validation failed."
		exit 1
	fi

	postgres_user="$(read_env_var POSTGRES_USER)"
	postgres_db="$(read_env_var POSTGRES_DB)"
	postgres_password="$(read_env_var POSTGRES_PASSWORD)"
	if [ -z "${postgres_user}" ] || [ -z "${postgres_db}" ] || [ -z "${postgres_password}" ]; then
		echo "POSTGRES_USER, POSTGRES_DB and POSTGRES_PASSWORD are required for database restore."
		exit 1
	fi

	echo "Stopping application services before database restore."
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup stop app backup || true
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml up -d postgres || fail_with_diagnostics
	wait_for_container_health expense-manager-postgres Postgres || fail_with_diagnostics

	echo "Restoring Postgres from ${backup_file}."
	if ! "${CONTAINER_CLI}" exec -e "PGPASSWORD=${postgres_password}" -i expense-manager-postgres \
		pg_restore \
		-U "${postgres_user}" \
		-d "${postgres_db}" \
		--clean \
		--if-exists \
		--no-owner \
		--single-transaction < "${backup_file}"; then
		echo "Database restore failed. The app was left stopped for investigation."
		fail_with_diagnostics
	fi
}

curl_headers=(-H "Accept: application/vnd.github.raw")
if [ -n "${GITHUB_TOKEN}" ]; then
	curl_headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

if [ -n "${ROLLBACK_COMPOSE_SHA}" ]; then
	echo "Refreshing compose files from ${ROLLBACK_COMPOSE_SHA} before rollback."
	fetch_repo_file docker-compose.traefik.yml docker-compose.yml
	fetch_repo_file scripts/backup.sh scripts/backup.sh
	fetch_repo_file docker/postgres/init.sql docker/postgres/init.sql
	chmod 700 scripts/backup.sh
fi

if [ ! -f docker-compose.yml ]; then
	echo "docker-compose.yml is missing in ${DEPLOY_PATH}; rollback cannot continue."
	exit 1
fi

if [ -z "${TARGET_IMAGE_TAG}" ]; then
	TARGET_IMAGE_TAG="$(read_env_var PREVIOUS_IMAGE_TAG)"
fi
if [ -z "${TARGET_IMAGE_TAG}" ]; then
	TARGET_IMAGE_TAG="$(read_env_var LAST_SUCCESSFUL_IMAGE_TAG)"
fi
if [ -z "${TARGET_IMAGE_TAG}" ]; then
	echo "No rollback image tag was provided and no PREVIOUS_IMAGE_TAG or LAST_SUCCESSFUL_IMAGE_TAG exists in .env."
	exit 1
fi

current_image_tag="$(read_env_var IMAGE_TAG)"
if [ -n "${current_image_tag}" ] && [ "${current_image_tag}" != "${TARGET_IMAGE_TAG}" ]; then
	upsert_env_var PREVIOUS_IMAGE_TAG "${current_image_tag}"
fi
upsert_env_var IMAGE_TAG "${TARGET_IMAGE_TAG}"

export REGISTRY="${REGISTRY:-$(read_env_var REGISTRY)}"
export IMAGE_OWNER_LOWERCASE="${IMAGE_OWNER_LOWERCASE:-$(read_env_var IMAGE_OWNER_LOWERCASE)}"
export IMAGE_TAG="${TARGET_IMAGE_TAG}"

echo "Rolling back image tag from ${current_image_tag:-unknown} to ${TARGET_IMAGE_TAG}."

"${COMPOSE_ARGS[@]}" -f docker-compose.yml pull app || fail_with_diagnostics
if backup_enabled; then
	if "${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup pull backup; then
		services=(app backup)
	else
		echo "Backup image for ${TARGET_IMAGE_TAG} was not available; rolling back the app only."
		services=(app)
	fi
else
	echo "Remote backup is disabled; rolling back app without backup service."
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup stop backup || true
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup rm -f backup || true
	services=(app)
fi

restore_database_backup

"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup up -d --remove-orphans "${services[@]}" || fail_with_diagnostics
wait_for_container_health expense-manager-app App || fail_with_diagnostics
verify_public_routes || fail_with_diagnostics

upsert_env_var LAST_ROLLBACK_IMAGE_TAG "${TARGET_IMAGE_TAG}"
upsert_env_var LAST_ROLLBACK_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
upsert_env_var LAST_ROLLBACK_REASON "manual"

dump_compose_diagnostics
