#!/bin/sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
postgres_host="${POSTGRES_HOST:-postgres}"
postgres_port="${POSTGRES_PORT:-5432}"
upload_dir="${UPLOAD_DIR:-/app/uploads}"
restic_host="${RESTIC_HOST:-expense-manager}"
restic_cache_dir="${RESTIC_CACHE_DIR:-/tmp/restic-cache}"
restic_init_repository="${RESTIC_INIT_REPOSITORY:-true}"
keep_daily="${RESTIC_KEEP_DAILY:-7}"
keep_weekly="${RESTIC_KEEP_WEEKLY:-4}"
keep_monthly="${RESTIC_KEEP_MONTHLY:-12}"
check_after_backup="${RESTIC_CHECK_AFTER_BACKUP:-false}"
work_dir="$(mktemp -d /tmp/expense-manager-backup.XXXXXX)"
db_file="${work_dir}/${POSTGRES_DB}_${timestamp}.dump"
uploads_file="${work_dir}/uploads_${timestamp}.tar.gz"

cleanup() {
	rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

require_env() {
	name="$1"
	eval "value=\${$name:-}"
	if [ -z "$value" ]; then
		echo "$name is required for remote backups." >&2
		exit 1
	fi
}

load_secret_file() {
	name="$1"
	eval "value=\${$name:-}"
	eval "file=\${${name}_FILE:-}"
	if [ -n "$value" ] || [ -z "$file" ]; then
		return 0
	fi
	if [ ! -f "$file" ]; then
		echo "${name}_FILE does not exist: $file" >&2
		exit 1
	fi
	value="$(sed -e 's/\r$//' "$file" | head -n 1)"
	export "$name=$value"
}

load_secret_file POSTGRES_PASSWORD
load_secret_file RESTIC_PASSWORD

require_env POSTGRES_DB
require_env POSTGRES_USER
require_env POSTGRES_PASSWORD
require_env RESTIC_REPOSITORY

if [ -z "${RESTIC_PASSWORD:-}" ] && [ -z "${RESTIC_PASSWORD_FILE:-}" ]; then
	echo "RESTIC_PASSWORD or RESTIC_PASSWORD_FILE is required for encrypted remote backups." >&2
	exit 1
fi

mkdir -p "$restic_cache_dir"
export PGPASSWORD="$POSTGRES_PASSWORD"
export RESTIC_CACHE_DIR="$restic_cache_dir"

echo "Creating Postgres logical backup."
pg_dump \
	-h "$postgres_host" \
	-p "$postgres_port" \
	-U "$POSTGRES_USER" \
	-d "$POSTGRES_DB" \
	-Fc \
	-f "$db_file"

pg_restore --list "$db_file" >/dev/null
sha256sum "$db_file" > "$db_file.sha256"

if [ -d "$upload_dir" ]; then
	echo "Creating uploads archive."
	tar -C "$upload_dir" -czf "$uploads_file" .
	tar -tzf "$uploads_file" >/dev/null
	sha256sum "$uploads_file" > "$uploads_file.sha256"
fi

if ! restic snapshots >/dev/null 2>&1; then
	if [ "$restic_init_repository" = "true" ]; then
		echo "Initializing restic repository."
		restic init
	else
		echo "Restic repository is not reachable or not initialized." >&2
		exit 1
	fi
fi

echo "Uploading encrypted backup to remote restic repository."
if [ -f "$uploads_file" ]; then
	restic backup \
		--host "$restic_host" \
		--tag expense-manager \
		--tag postgres \
		--tag uploads \
		"$db_file" \
		"$db_file.sha256" \
		"$uploads_file" \
		"$uploads_file.sha256"
else
	restic backup \
		--host "$restic_host" \
		--tag expense-manager \
		--tag postgres \
		"$db_file" \
		"$db_file.sha256"
fi

echo "Applying remote backup retention."
restic forget \
	--host "$restic_host" \
	--tag expense-manager \
	--keep-daily "$keep_daily" \
	--keep-weekly "$keep_weekly" \
	--keep-monthly "$keep_monthly" \
	--prune

if [ "$check_after_backup" = "true" ]; then
	echo "Running restic repository check."
	restic check
fi

echo "remote_backup_created=$timestamp"
