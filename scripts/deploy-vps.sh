#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/expense-manager}"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose}"
REGISTRY="${REGISTRY:-ghcr.io}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA is required}"
HEAD_SHA_SHORT="$(printf '%s' "${HEAD_SHA}" | cut -c1-7)"
IMAGE_OWNER="${IMAGE_OWNER:?IMAGE_OWNER is required}"
IMAGE_TAG="${IMAGE_TAG:-sha-${HEAD_SHA_SHORT}}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
PREDEPLOY_BACKUP_PATH=""
previous_image_tag=""

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

echo "::group::Deploy expense-manager"
echo "Compose command: ${COMPOSE_CMD}"
echo "Image tag      : ${IMAGE_TAG}"
echo "Commit         : ${HEAD_SHA}"
echo "::endgroup::"

mkdir -p "${DEPLOY_PATH}"
cd "${DEPLOY_PATH}"

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

rollback_images() {
	reason="$1"
	echo "=========================================="
	echo "ROLLBACK: ${reason}"
	echo "=========================================="
	echo "Diagnostics before rollback:"
	dump_compose_diagnostics

	if [ -z "${previous_image_tag}" ] || [ "${previous_image_tag}" = "${IMAGE_TAG}" ]; then
		echo "No previous IMAGE_TAG recorded; cannot perform image rollback."
		fail_with_diagnostics
	fi

	echo "Reverting containers from ${IMAGE_TAG} to ${previous_image_tag}."
	upsert_env_var IMAGE_TAG "${previous_image_tag}"
	ensure_legacy_auth_secret
	ensure_legacy_database_url
	write_compose_secret_files
	export IMAGE_TAG="${previous_image_tag}"

	rollback_services=(app)
	if backup_enabled; then
		rollback_services+=(backup)
		"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup pull app backup || fail_with_diagnostics
	else
		echo "Remote backup is disabled; rolling back app without backup service."
		"${COMPOSE_ARGS[@]}" -f docker-compose.yml pull app || fail_with_diagnostics
		"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup stop backup || true
		"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup rm -f backup || true
	fi
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup up -d --remove-orphans "${rollback_services[@]}" || fail_with_diagnostics
	wait_for_container_health expense-manager-app App || fail_with_diagnostics
	verify_public_routes || fail_with_diagnostics
	upsert_env_var LAST_ROLLBACK_IMAGE_TAG "${previous_image_tag}"
	upsert_env_var LAST_ROLLBACK_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	upsert_env_var LAST_ROLLBACK_REASON "${reason}"

	if [ -n "${PREDEPLOY_BACKUP_PATH}" ]; then
		echo "Image rollback completed. Database was not restored automatically."
		echo "Pre-deploy database backup for manual restore: ${DEPLOY_PATH}/${PREDEPLOY_BACKUP_PATH}"
	fi

	dump_compose_diagnostics
	exit 2
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
	"${CONTAINER_CLI}" inspect \
		-f '{{range .State.Health.Log}}{{.Start}} exit={{.ExitCode}} {{.Output}}{{"\n"}}{{end}}' \
		"${container}" 2>/dev/null || true
	return 1
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

delete_env_var() {
	key="$1"
	tmp_file="$(mktemp)"
	grep -v -E "^${key}=" .env > "${tmp_file}" || true
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

image_cleanup_enabled() {
	case "$(read_env_var IMAGE_CLEANUP_ENABLED | tr '[:upper:]' '[:lower:]')" in
		"" | true | 1 | yes | on) return 0 ;;
		false | 0 | no | off) return 1 ;;
		*)
			echo "IMAGE_CLEANUP_ENABLED must be true or false."
			exit 1
			;;
	esac
}

normalize_domain_name() {
	raw_domain="$(read_env_var DOMAIN_NAME)"
	normalized_domain="$(printf '%s' "${raw_domain}" \
		| sed -E 's#^[[:alpha:]][[:alnum:]+.-]*://##; s#/.*$##; s#:[0-9]+$##' \
		| tr '[:upper:]' '[:lower:]')"

	if [ -z "${normalized_domain}" ]; then
		echo "DOMAIN_NAME is missing in ${DEPLOY_PATH}/.env. Set it to a bare host, for example finance.example.com."
		exit 1
	fi

	if [ "${raw_domain}" != "${normalized_domain}" ]; then
		echo "Normalizing DOMAIN_NAME for Traefik Host matching."
		upsert_env_var DOMAIN_NAME "${normalized_domain}"
	fi

	if [ -z "$(read_env_var ORIGIN)" ]; then
		echo "ORIGIN is missing; setting it from DOMAIN_NAME."
		upsert_env_var ORIGIN "https://${normalized_domain}"
	fi
}

ensure_compose_secret_defaults() {
	for key in RESTIC_PASSWORD; do
		if ! grep -Eq "^${key}=" .env; then
			upsert_env_var "${key}" ""
		fi
	done
}

write_compose_secret_file() {
	secret_name="$1"
	env_key="$2"
	required="$3"
	value="$(read_env_var "${env_key}")"

	if [ "${required}" = "required" ] && [ -z "${value}" ]; then
		echo "${env_key} is required to create Compose secret ${secret_name}."
		exit 1
	fi

	mkdir -p secrets
	chmod 700 secrets
	# Make file writable before overwriting in case a previous deploy set it to 444.
	chmod 644 "secrets/${secret_name}" 2>/dev/null || true
	printf '%s' "${value}" > "secrets/${secret_name}"
	# Docker Compose file secrets are bind mounts in standalone mode. Keep the
	# directory private on the host, but make mounted files readable to
	# cap-dropped/non-root containers.
	chmod 444 "secrets/${secret_name}"
}

write_compose_secret_files() {
	write_compose_secret_file better_auth_secret BETTER_AUTH_SECRET required
	write_compose_secret_file postgres_password POSTGRES_PASSWORD required
	write_compose_secret_file restic_password RESTIC_PASSWORD optional
}

ensure_legacy_auth_secret() {
	auth_secret="$(read_env_var BETTER_AUTH_SECRET)"
	if [ -z "${auth_secret}" ]; then
		echo "BETTER_AUTH_SECRET is required to build legacy auth compatibility settings."
		exit 1
	fi

	upsert_env_var BETTER_AUTH_SECRET_COMPAT "${auth_secret}"
}

ensure_legacy_database_url() {
	postgres_user="$(read_env_var POSTGRES_USER)"
	postgres_db="$(read_env_var POSTGRES_DB)"
	postgres_password="$(read_env_var POSTGRES_PASSWORD)"
	if [ -z "${postgres_user}" ] || [ -z "${postgres_db}" ] || [ -z "${postgres_password}" ]; then
		echo "POSTGRES_USER, POSTGRES_DB and POSTGRES_PASSWORD are required to build legacy DATABASE_URL."
		exit 1
	fi

	database_url="$(POSTGRES_USER="${postgres_user}" POSTGRES_PASSWORD="${postgres_password}" POSTGRES_DB="${postgres_db}" python3 - <<'PY'
import os
from urllib.parse import quote

user = quote(os.environ["POSTGRES_USER"], safe="")
password = quote(os.environ["POSTGRES_PASSWORD"], safe="")
database = quote(os.environ["POSTGRES_DB"], safe="")
print(f"postgresql://{user}:{password}@postgres:5432/{database}")
PY
)"
	upsert_env_var DATABASE_URL "${database_url}"
}

cleanup_old_application_images() {
	if ! image_cleanup_enabled; then
		echo "Image cleanup disabled by IMAGE_CLEANUP_ENABLED=false."
		return 0
	fi

	keep_tags=(
		"${IMAGE_TAG}"
		"$(read_env_var PREVIOUS_IMAGE_TAG)"
		"$(read_env_var LAST_SUCCESSFUL_IMAGE_TAG)"
		"$(read_env_var LAST_ROLLBACK_IMAGE_TAG)"
		latest
	)

	echo "Cleaning old Expense Manager image tags."
	for suffix in app migrate backup; do
		repository="${REGISTRY}/${IMAGE_OWNER}/expense-manager-${suffix}"
		"${CONTAINER_CLI}" image ls --format '{{.Repository}} {{.Tag}} {{.ID}}' "${repository}" |
			while read -r image_repository image_tag image_id; do
				[ -n "${image_repository}" ] || continue
				[ "${image_tag}" != "<none>" ] || continue

				keep_image=false
				for keep_tag in "${keep_tags[@]}"; do
					if [ -n "${keep_tag}" ] && [ "${image_tag}" = "${keep_tag}" ]; then
						keep_image=true
						break
					fi
				done

				if [ "${keep_image}" = true ]; then
					continue
				fi

				if "${CONTAINER_CLI}" image rm "${image_repository}:${image_tag}" >/dev/null 2>&1; then
					echo "Removed old image tag ${image_repository}:${image_tag} (${image_id})."
				else
					echo "Skipped image tag ${image_repository}:${image_tag}; it may still be in use."
				fi
			done
	done
}

curl_public_route() {
	domain="$1"
	path="$2"
	label="$3"
	url="https://${domain}${path}"
	attempts="${PUBLIC_ROUTE_RETRIES:-36}"
	delay_seconds="${PUBLIC_ROUTE_RETRY_DELAY_SECONDS:-5}"
	last_error=""

	for attempt in $(seq 1 "${attempts}"); do
		if last_error="$(curl --fail --show-error --silent --max-time 15 \
			--resolve "${domain}:443:127.0.0.1" \
			-o /dev/null \
			"${url}" 2>&1)"; then
			echo "${label} public route responded through local Traefik"
			return 0
		fi

		if last_error="$(curl --fail --show-error --silent --max-time 15 \
			-o /dev/null \
			"${url}" 2>&1)"; then
			echo "${label} public route responded through DNS"
			return 0
		fi

		if [ "${attempt}" -lt "${attempts}" ]; then
			echo "${label} public route not ready yet; retrying in ${delay_seconds}s (${attempt}/${attempts})"
			sleep "${delay_seconds}"
		fi
	done

	echo "${label} public route did not respond after ${attempts} attempts"
	if [ -n "${last_error}" ]; then
		echo "Last public route error: ${last_error}"
	fi
	return 1
}

verify_public_routes() {
	domain="$(read_env_var DOMAIN_NAME)"
	curl_public_route "${domain}" "/api/health" "Application health" &&
		curl_public_route "${domain}" "/" "Application root"
}

backup_existing_database() {
	if ! "${CONTAINER_CLI}" inspect expense-manager-postgres >/dev/null 2>&1; then
		echo "No existing Postgres container found; skipping pre-deploy backup."
		return 0
	fi

	status="$("${CONTAINER_CLI}" inspect -f '{{.State.Status}}' expense-manager-postgres 2>/dev/null || true)"
	if [ "${status}" != "running" ]; then
		echo "Postgres container status is '${status:-missing}'; skipping pre-deploy backup."
		return 0
	fi

	postgres_user="$(read_env_var POSTGRES_USER)"
	postgres_db="$(read_env_var POSTGRES_DB)"
	postgres_password="$(read_env_var POSTGRES_PASSWORD)"
	if [ -z "${postgres_user}" ] || [ -z "${postgres_db}" ] || [ -z "${postgres_password}" ]; then
		echo "POSTGRES_USER, POSTGRES_DB and POSTGRES_PASSWORD are required for pre-deploy backup."
		exit 1
	fi

	mkdir -p backups/predeploy
	chmod 750 backups backups/predeploy
	timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
	backup_path="backups/predeploy/${postgres_db}-${timestamp}-${HEAD_SHA_SHORT}.dump"

	echo "Creating pre-deploy Postgres backup."
	if ! "${CONTAINER_CLI}" exec -e "PGPASSWORD=${postgres_password}" -i expense-manager-postgres \
		pg_dump -U "${postgres_user}" -d "${postgres_db}" -Fc > "${backup_path}"; then
		rm -f "${backup_path}"
		echo "Pre-deploy backup failed."
		exit 1
	fi

	if ! "${CONTAINER_CLI}" run --rm -i -v "${PWD}/backups/predeploy:/restore:ro" postgres:18-alpine \
		pg_restore --list "/restore/$(basename "${backup_path}")" >/dev/null; then
		rm -f "${backup_path}"
		echo "Pre-deploy backup validation failed."
		exit 1
	fi

	sha256sum "${backup_path}" > "${backup_path}.sha256"
	PREDEPLOY_BACKUP_PATH="${backup_path}"
	upsert_env_var LAST_PREDEPLOY_BACKUP "${backup_path}"
	find backups/predeploy -type f -name "${postgres_db}-*.dump" | sort | head -n -10 | while read -r old_backup; do
		rm -f "${old_backup}" "${old_backup}.sha256"
	done
}

fetch_repo_file() {
	remote_path="$1"
	local_path="$2"
	mkdir -p "$(dirname "${local_path}")"
	curl -fsSL "${curl_headers[@]}" \
		-o "${local_path}" \
		"https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${HEAD_SHA}/${remote_path}"
}

curl_headers=(-H "Accept: application/vnd.github.raw")
if [ -n "${GITHUB_TOKEN}" ]; then
	curl_headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

fetch_repo_file docker-compose.traefik.yml docker-compose.yml
fetch_repo_file scripts/backup.sh scripts/backup.sh
fetch_repo_file scripts/rollback-vps.sh scripts/rollback-vps.sh
fetch_repo_file docker/postgres/init.sql docker/postgres/init.sql
chmod 700 scripts/backup.sh
chmod 700 scripts/rollback-vps.sh

if [ ! -f .env ]; then
	echo ".env is missing in ${DEPLOY_PATH}; configure VPS_ENV_FILE in the GitHub production environment or create .env manually before deploying."
	exit 1
fi
chmod 600 .env
normalize_domain_name
ensure_compose_secret_defaults
write_compose_secret_files
delete_env_var BETTER_AUTH_SECRET_COMPAT
delete_env_var DATABASE_URL

previous_image_tag="$(read_env_var IMAGE_TAG)"
if [ -n "${previous_image_tag}" ] && [ "${previous_image_tag}" != "${IMAGE_TAG}" ]; then
	upsert_env_var PREVIOUS_IMAGE_TAG "${previous_image_tag}"
fi
upsert_env_var REGISTRY "${REGISTRY}"
upsert_env_var IMAGE_OWNER_LOWERCASE "${IMAGE_OWNER}"
upsert_env_var IMAGE_TAG "${IMAGE_TAG}"

export REGISTRY
export IMAGE_OWNER_LOWERCASE="${IMAGE_OWNER}"
export IMAGE_TAG

compose_profiles=(--profile tools)
deploy_services=(app)
if backup_enabled; then
	compose_profiles+=(--profile backup)
	deploy_services+=(backup)
else
	echo "WARNING: BACKUP_ENABLED=false. Remote backups are disabled for this deploy."
	echo "This is acceptable for bootstrap only; configure remote restic backups before storing important data."
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup stop backup || true
	"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup rm -f backup || true
fi

"${COMPOSE_ARGS[@]}" -f docker-compose.yml "${compose_profiles[@]}" pull || fail_with_diagnostics
"${COMPOSE_ARGS[@]}" -f docker-compose.yml up -d postgres || fail_with_diagnostics
wait_for_container_health expense-manager-postgres Postgres || fail_with_diagnostics

backup_existing_database

"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile tools run --rm migrate || rollback_images "Migration failed"
"${COMPOSE_ARGS[@]}" -f docker-compose.yml --profile backup up -d --remove-orphans "${deploy_services[@]}" || rollback_images "Container restart failed"

wait_for_container_health expense-manager-postgres Postgres || fail_with_diagnostics
wait_for_container_health expense-manager-app App || rollback_images "Application health check failed"
verify_public_routes || rollback_images "Public route smoke check failed"

upsert_env_var LAST_SUCCESSFUL_IMAGE_TAG "${IMAGE_TAG}"
upsert_env_var LAST_SUCCESSFUL_DEPLOY_SHA "${HEAD_SHA}"
cleanup_old_application_images
