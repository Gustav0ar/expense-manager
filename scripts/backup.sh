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
attachment_manifest="${work_dir}/attachment_manifest_${timestamp}.tsv"
attachment_storage_lock_key=7273299174
attachment_delete_grace_seconds=172800
max_capture_seconds="${ATTACHMENT_BACKUP_MAX_CAPTURE_SECONDS:-86400}"
snapshot_fifo="${work_dir}/snapshot.sql"
snapshot_id_file="${work_dir}/snapshot.id"
snapshot_pid=""
snapshot_open=false
capture_started_at=""
capture_deadline=""

capture_command() {
	remaining=$((capture_deadline - $(date +%s)))
	if [ "$remaining" -le 0 ]; then
		echo "Backup capture exceeded the documented attachment deletion safety window." >&2
		exit 1
	fi
	timeout -k 5 "$remaining" "$@"
}

close_snapshot() {
	if [ "$snapshot_open" = "true" ]; then
		kill "$snapshot_pid" 2>/dev/null || true
		wait "$snapshot_pid" || true
		snapshot_open=false
	fi
}

cleanup() {
	close_snapshot
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

case "$max_capture_seconds" in
	''|*[!0-9]*) echo "ATTACHMENT_BACKUP_MAX_CAPTURE_SECONDS must be an integer." >&2; exit 1 ;;
esac
if [ "$max_capture_seconds" -ge "$attachment_delete_grace_seconds" ]; then
	echo "Attachment backup capture limit must remain below the 48-hour deletion grace." >&2
	exit 1
fi

echo "Opening a consistent attachment backup snapshot."
mkfifo "$snapshot_fifo"
psql -X -qAt -v ON_ERROR_STOP=1 \
	-h "$postgres_host" -p "$postgres_port" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
	< "$snapshot_fifo" > /dev/null &
snapshot_pid=$!
exec 3>"$snapshot_fifo"
snapshot_open=true
printf '%s\n' \
	'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;' \
	"SELECT pg_advisory_xact_lock(${attachment_storage_lock_key});" \
	"\\copy (SELECT pg_export_snapshot()) TO '${snapshot_id_file}'" \
	"SELECT pg_sleep($((max_capture_seconds + 300)));" >&3
exec 3>&-

snapshot_id=""
snapshot_waited=0
while [ -z "$snapshot_id" ] && [ "$snapshot_waited" -lt 30 ]; do
	snapshot_id="$(grep -E '^[0-9A-F]+-[0-9A-F]+-[0-9]+$' "$snapshot_id_file" 2>/dev/null | tail -n 1 || true)"
	if [ -z "$snapshot_id" ]; then
		if ! kill -0 "$snapshot_pid" 2>/dev/null; then
			echo "Could not establish the attachment backup snapshot." >&2
			exit 1
		fi
		sleep 1
		snapshot_waited=$((snapshot_waited + 1))
	fi
done
if [ -z "$snapshot_id" ]; then
	echo "Timed out establishing the attachment backup snapshot." >&2
	exit 1
fi
capture_started_at="$(date +%s)"
capture_deadline=$((capture_started_at + max_capture_seconds))

echo "Creating Postgres logical backup from the shared snapshot."
capture_command pg_dump \
	-h "$postgres_host" \
	-p "$postgres_port" \
	-U "$POSTGRES_USER" \
	-d "$POSTGRES_DB" \
	-Fc \
	--snapshot="$snapshot_id" \
	-f "$db_file"

capture_command pg_restore --list "$db_file" >/dev/null
capture_command sha256sum "$db_file" > "$db_file.sha256"

capture_command psql -X -qAt -v ON_ERROR_STOP=1 \
	-h "$postgres_host" -p "$postgres_port" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
	-c "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT '${snapshot_id}'; COPY (
		SELECT storage_key, size_bytes, sha256 FROM (
			SELECT ea.storage_key, ea.size_bytes, ea.sha256
			FROM expense_attachment ea
			WHERE ea.deleted_at IS NULL
			UNION
			SELECT d.storage_key, d.size_bytes, d.sha256
			FROM attachment_deletion d
			WHERE d.status <> 'completed'
		) retained
		ORDER BY storage_key
	) TO STDOUT WITH (FORMAT csv, DELIMITER E'\\t', HEADER true); COMMIT;" > "$attachment_manifest"

verify_manifest_files() {
	root="$1"
	tail -n +2 "$attachment_manifest" | while IFS="$(printf '\t')" read -r storage_key expected_size expected_sha; do
		[ -n "$storage_key" ] || continue
		case "$storage_key" in
			/*|../*|*/../*|*/..) echo "Unsafe storage key in attachment manifest." >&2; exit 1 ;;
		esac
		file_path="${root}/${storage_key}"
		if [ ! -f "$file_path" ]; then
			echo "Attachment manifest references a missing file." >&2
			exit 1
		fi
		actual_size="$(capture_command wc -c < "$file_path" | tr -d ' ')"
		actual_sha="$(capture_command sha256sum "$file_path" | awk '{print $1}')"
		if [ "$actual_size" != "$expected_size" ] || [ "$actual_sha" != "$expected_sha" ]; then
			echo "Attachment manifest size or checksum mismatch." >&2
			exit 1
		fi
	done
}

if [ -d "$upload_dir" ]; then
	verify_manifest_files "$upload_dir"
	echo "Creating uploads archive."
	capture_command tar -C "$upload_dir" -czf "$uploads_file" .
	capture_command tar -tzf "$uploads_file" >/dev/null
	capture_command sha256sum "$uploads_file" > "$uploads_file.sha256"
	verify_upload_dir="${work_dir}/verified-uploads"
	mkdir -p "$verify_upload_dir"
	capture_command tar -C "$verify_upload_dir" -xzf "$uploads_file"
	verify_manifest_files "$verify_upload_dir"
elif [ "$(wc -l < "$attachment_manifest" | tr -d ' ')" -gt 1 ]; then
	echo "Attachment metadata exists but the upload directory is missing." >&2
	exit 1
fi

capture_duration=$(( $(date +%s) - capture_started_at ))
if [ "$capture_duration" -ge "$max_capture_seconds" ]; then
	echo "Backup capture exceeded the documented attachment deletion safety window." >&2
	exit 1
fi
close_snapshot
sha256sum "$attachment_manifest" > "$attachment_manifest.sha256"

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
		"$attachment_manifest" \
		"$attachment_manifest.sha256" \
		"$uploads_file" \
		"$uploads_file.sha256"
else
	restic backup \
		--host "$restic_host" \
		--tag expense-manager \
		--tag postgres \
		"$db_file" \
		"$db_file.sha256" \
		"$attachment_manifest" \
		"$attachment_manifest.sha256"
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
