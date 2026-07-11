#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_url="${DATABASE_URL:?DATABASE_URL is required}"
database_name="expense_manager_backup_test_${$}_$(date +%s)"
[[ "${database_name}" =~ ^expense_manager_backup_test_[0-9]+_[0-9]+$ ]] || exit 1
temp_root="$(mktemp -d /tmp/expense-manager-backup-test.XXXXXX)"
upload_dir="${temp_root}/uploads"
artifact_dir="${temp_root}/artifacts"
fake_bin="${temp_root}/bin"
race_marker="${temp_root}/snapshot-exported"
database_created=false
backup_pid=""

target_url="$({ DATABASE_URL="${database_url}" TEMP_DATABASE="${database_name}" python3 - <<'PY'
import os
import urllib.parse

url = urllib.parse.urlsplit(os.environ["DATABASE_URL"])
print(urllib.parse.urlunsplit((url.scheme, url.netloc, "/" + os.environ["TEMP_DATABASE"], url.query, url.fragment)))
PY
})"

cleanup() {
	if [[ -n "${backup_pid}" ]] && kill -0 "${backup_pid}" 2>/dev/null; then
		kill "${backup_pid}" 2>/dev/null || true
		wait "${backup_pid}" 2>/dev/null || true
	fi
	if [[ "${database_created}" == true ]]; then
		dropdb --if-exists --force --maintenance-db="${database_url}" "${database_name}" >/dev/null
	fi
	rm -rf "${temp_root}"
}
trap cleanup EXIT INT TERM

mkdir -p "${upload_dir}/1/1" "${artifact_dir}" "${fake_bin}"
real_pg_dump="$(command -v pg_dump)"
cat > "${fake_bin}/pg_dump" <<'SH'
#!/bin/sh
touch "${BACKUP_RACE_MARKER}"
sleep 2
exec "${REAL_PG_DUMP}" "$@"
SH
cat > "${fake_bin}/restic" <<'SH'
#!/bin/sh
command="$1"
shift
case "$command" in
	snapshots|forget|check|init) exit 0 ;;
	backup)
		for value in "$@"; do
			if [ -f "$value" ]; then cp "$value" "${BACKUP_TEST_ARTIFACT_DIR}/"; fi
		done
		;;
	*) exit 1 ;;
esac
SH
chmod 755 "${fake_bin}/pg_dump" "${fake_bin}/restic"

createdb --maintenance-db="${database_url}" "${database_name}"
database_created=true
DATABASE_URL="${target_url}" pnpm --dir "${repo_root}" db:migrate >/dev/null

printf 'snapshot-active' > "${upload_dir}/1/1/active.txt"
printf 'retained-delete' > "${upload_dir}/1/1/retained.txt"
active_sha="$(sha256sum "${upload_dir}/1/1/active.txt" | awk '{print $1}')"
retained_sha="$(sha256sum "${upload_dir}/1/1/retained.txt" | awk '{print $1}')"
active_size="$(wc -c < "${upload_dir}/1/1/active.txt" | tr -d ' ')"
retained_size="$(wc -c < "${upload_dir}/1/1/retained.txt" | tr -d ' ')"

psql "${target_url}" -X -q -v ON_ERROR_STOP=1 \
	-v active_sha="${active_sha}" -v retained_sha="${retained_sha}" \
	-v active_size="${active_size}" -v retained_size="${retained_size}" <<'SQL'
INSERT INTO "user" (id, name, email, email_verified) VALUES
	('backup-test-user', 'Backup test', 'backup-test@example.com', true);
INSERT INTO workspace (id, name, currency, created_by_user_id)
	OVERRIDING SYSTEM VALUE VALUES (1, 'Backup test', 'USD', 'backup-test-user');
INSERT INTO category (id, workspace_id, name, color)
	OVERRIDING SYSTEM VALUE VALUES (1, 1, 'Backup', '#123456');
INSERT INTO expense (id, workspace_id, category_id, created_by_user_id, description, amount_cents, expense_date)
	OVERRIDING SYSTEM VALUE VALUES (1, 1, 1, 'backup-test-user', 'Backup', 100, '2026-07-11');
INSERT INTO expense_attachment (
	id, workspace_id, expense_id, uploaded_by_user_id, original_name, content_type,
	size_bytes, storage_key, sha256
) OVERRIDING SYSTEM VALUE VALUES
	(1, 1, 1, 'backup-test-user', 'active.txt', 'text/plain', :active_size, '1/1/active.txt', :'active_sha'),
	(2, 1, 1, 'backup-test-user', 'retained.txt', 'text/plain', :retained_size, '1/1/retained.txt', :'retained_sha');
DELETE FROM expense_attachment WHERE id = 2;
SQL

db_host="$(DATABASE_URL="${target_url}" python3 -c 'import os,urllib.parse; print(urllib.parse.urlsplit(os.environ["DATABASE_URL"]).hostname)')"
db_port="$(DATABASE_URL="${target_url}" python3 -c 'import os,urllib.parse; print(urllib.parse.urlsplit(os.environ["DATABASE_URL"]).port or 5432)')"
db_user="$(DATABASE_URL="${target_url}" python3 -c 'import os,urllib.parse; print(urllib.parse.unquote(urllib.parse.urlsplit(os.environ["DATABASE_URL"]).username or ""))')"
db_password="$(DATABASE_URL="${target_url}" python3 -c 'import os,urllib.parse; print(urllib.parse.unquote(urllib.parse.urlsplit(os.environ["DATABASE_URL"]).password or ""))')"

PATH="${fake_bin}:${PATH}" \
REAL_PG_DUMP="${real_pg_dump}" \
BACKUP_RACE_MARKER="${race_marker}" \
BACKUP_TEST_ARTIFACT_DIR="${artifact_dir}" \
POSTGRES_HOST="${db_host}" POSTGRES_PORT="${db_port}" \
POSTGRES_DB="${database_name}" POSTGRES_USER="${db_user}" POSTGRES_PASSWORD="${db_password}" \
UPLOAD_DIR="${upload_dir}" RESTIC_REPOSITORY="test:repository" RESTIC_PASSWORD="test-password" \
sh "${repo_root}/scripts/backup.sh" > "${temp_root}/backup.log" 2>&1 &
backup_pid=$!

for _ in $(seq 1 30); do
	[[ -f "${race_marker}" ]] && break
	sleep 0.1
done
[[ -f "${race_marker}" ]] || {
	echo "Backup did not export a snapshot." >&2
	cat "${temp_root}/backup.log" >&2
	exit 1
}

lock_acquired="$(psql "${target_url}" -X -qAt -v ON_ERROR_STOP=1 -c 'select pg_try_advisory_lock(7273299174)')"
[[ "${lock_acquired}" == false || "${lock_acquired}" == f ]] || {
	echo "Attachment deletion lock was not held during backup capture." >&2
	exit 1
}

printf 'post-snapshot-extra' > "${upload_dir}/1/1/extra.txt"
extra_sha="$(sha256sum "${upload_dir}/1/1/extra.txt" | awk '{print $1}')"
extra_size="$(wc -c < "${upload_dir}/1/1/extra.txt" | tr -d ' ')"
psql "${target_url}" -X -q -v ON_ERROR_STOP=1 -v extra_sha="${extra_sha}" -v extra_size="${extra_size}" <<'SQL'
DELETE FROM expense_attachment WHERE id = 1;
INSERT INTO expense_attachment (
	id, workspace_id, expense_id, uploaded_by_user_id, original_name, content_type,
	size_bytes, storage_key, sha256
) OVERRIDING SYSTEM VALUE VALUES
	(3, 1, 1, 'backup-test-user', 'extra.txt', 'text/plain', :extra_size, '1/1/extra.txt', :'extra_sha');
SQL

if ! wait "${backup_pid}"; then
	cat "${temp_root}/backup.log" >&2
	exit 1
fi
backup_pid=""

db_dump="$(find "${artifact_dir}" -name '*.dump' -print -quit)"
uploads_archive="$(find "${artifact_dir}" -name 'uploads_*.tar.gz' -print -quit)"
manifest="$(find "${artifact_dir}" -name 'attachment_manifest_*.tsv' -print -quit)"
[[ -n "${db_dump}" && -n "${uploads_archive}" && -n "${manifest}" ]] || {
	cat "${temp_root}/backup.log" >&2
	exit 1
}

RECOVERY_DATABASE_URL="${database_url}" \
	"${repo_root}/scripts/ops/verify-attachment-recovery.sh" \
	"${db_dump}" "${uploads_archive}" "${manifest}"

rm -f "${artifact_dir}"/* "${race_marker}"
if PATH="${fake_bin}:${PATH}" \
	REAL_PG_DUMP="${real_pg_dump}" \
	BACKUP_RACE_MARKER="${race_marker}" \
	BACKUP_TEST_ARTIFACT_DIR="${artifact_dir}" \
	ATTACHMENT_BACKUP_MAX_CAPTURE_SECONDS=1 \
	POSTGRES_HOST="${db_host}" POSTGRES_PORT="${db_port}" \
	POSTGRES_DB="${database_name}" POSTGRES_USER="${db_user}" POSTGRES_PASSWORD="${db_password}" \
	UPLOAD_DIR="${upload_dir}" RESTIC_REPOSITORY="test:repository" RESTIC_PASSWORD="test-password" \
	sh "${repo_root}/scripts/backup.sh" >/dev/null 2>&1; then
	echo "Short backup deadline unexpectedly succeeded." >&2
	exit 1
fi
if find "${artifact_dir}" -type f -print -quit | grep -q .; then
	echo "Timed-out backup uploaded an artifact." >&2
	exit 1
fi

echo "attachment_backup_race_verified=true"
