#!/usr/bin/env bash
set -Eeuo pipefail

database_url="${RECOVERY_DATABASE_URL:-${DATABASE_URL:-}}"
db_dump="${1:-${RECOVERY_DB_DUMP:-}}"
uploads_archive="${2:-${RECOVERY_UPLOADS_ARCHIVE:-}}"
attachment_manifest="${3:-${RECOVERY_ATTACHMENT_MANIFEST:-}}"

for command in createdb dropdb pg_restore psql tar sha256sum; do
	command -v "${command}" >/dev/null 2>&1 || {
		echo "${command} is required for the attachment recovery verification." >&2
		exit 1
	}
done

if [[ -z "${database_url}" || ! -f "${db_dump}" || ! -f "${attachment_manifest}" ]]; then
	echo "RECOVERY_DATABASE_URL, a database dump and an attachment manifest are required." >&2
	exit 1
fi
if [[ ! -f "${uploads_archive}" ]]; then
	if [[ "$(wc -l < "${attachment_manifest}")" -gt 1 ]]; then
		echo "The uploads archive is required when the manifest contains attachments." >&2
		exit 1
	fi
fi

database_name="expense_manager_recovery_drill_${$}_$(date +%s)"
if [[ ! "${database_name}" =~ ^expense_manager_recovery_drill_[0-9]+_[0-9]+$ ]]; then
	echo "Refusing unsafe recovery database name." >&2
	exit 1
fi
restore_root="$(mktemp -d /tmp/expense-manager-attachment-recovery.XXXXXX)"
database_created=false

target_url="$({ DATABASE_URL="${database_url}" RECOVERY_DB="${database_name}" python3 - <<'PY'
import os
import urllib.parse

url = urllib.parse.urlsplit(os.environ["DATABASE_URL"])
print(urllib.parse.urlunsplit((url.scheme, url.netloc, "/" + os.environ["RECOVERY_DB"], url.query, url.fragment)))
PY
})"

cleanup() {
	if [[ "${database_created}" == true ]]; then
		dropdb --if-exists --force --maintenance-db="${database_url}" "${database_name}" >/dev/null
	fi
	rm -rf "${restore_root}"
}
trap cleanup EXIT INT TERM

pg_restore --list "${db_dump}" >/dev/null
createdb --maintenance-db="${database_url}" "${database_name}"
database_created=true
pg_restore --exit-on-error --single-transaction --dbname="${target_url}" "${db_dump}"

if [[ -f "${uploads_archive}" ]]; then
	tar -tzf "${uploads_archive}" >/dev/null
	tar -C "${restore_root}" -xzf "${uploads_archive}"
fi

restored_manifest="${restore_root}/restored-metadata.tsv"
psql "${target_url}" -X -qAt -v ON_ERROR_STOP=1 -c "COPY (
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
) TO STDOUT WITH (FORMAT csv, DELIMITER E'\\t', HEADER true)" > "${restored_manifest}"

if ! cmp -s "${attachment_manifest}" "${restored_manifest}"; then
	echo "Restored attachment metadata does not match the backup manifest." >&2
	exit 1
fi

verified=0
tail -n +2 "${restored_manifest}" |
	while IFS=$'\t' read -r storage_key expected_size expected_sha; do
		[[ -n "${storage_key}" ]] || continue
		case "${storage_key}" in
			/*|../*|*/../*|*/..)
				echo "Unsafe storage key in restored metadata." >&2
				exit 1
				;;
		esac
		file_path="${restore_root}/${storage_key}"
		[[ -f "${file_path}" ]] || {
			echo "Restored metadata references a missing attachment." >&2
			exit 1
		}
		actual_size="$(wc -c < "${file_path}" | tr -d ' ')"
		actual_sha="$(sha256sum "${file_path}" | awk '{print $1}')"
		[[ "${actual_size}" == "${expected_size}" && "${actual_sha}" == "${expected_sha}" ]] || {
			echo "Restored attachment size or checksum does not match metadata." >&2
			exit 1
		}
		verified=$((verified + 1))
	done

echo "attachment_recovery_verified=true"
