#!/bin/sh
set -eu

backup_dir="${BACKUP_DIR:-/backups}"
upload_dir="${UPLOAD_DIR:-/app/uploads}"
offsite_dir="${BACKUP_OFFSITE_DIR:-}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
db_file="${backup_dir}/${POSTGRES_DB}_${timestamp}.dump"
uploads_file="${backup_dir}/uploads_${timestamp}.tar.gz"

mkdir -p "$backup_dir"

checksum_file() {
	sha256sum "$1" > "$1.sha256"
}

copy_to_offsite() {
	file="$1"
	if [ -n "$offsite_dir" ] && [ "$offsite_dir" != "$backup_dir" ]; then
		mkdir -p "$offsite_dir"
		cp -p "$file" "$file.sha256" "$offsite_dir"/
		echo "offsite_backup_copied=$offsite_dir/$(basename "$file")"
	fi
}

export PGPASSWORD="${POSTGRES_PASSWORD}"
pg_dump \
	-h postgres \
	-U "${POSTGRES_USER}" \
	-d "${POSTGRES_DB}" \
	-Fc \
	-f "$db_file"

pg_restore --list "$db_file" >/dev/null
checksum_file "$db_file"
copy_to_offsite "$db_file"

if [ -d "$upload_dir" ]; then
	tar -C "$upload_dir" -czf "$uploads_file" .
	tar -tzf "$uploads_file" >/dev/null
	checksum_file "$uploads_file"
	copy_to_offsite "$uploads_file"
	echo "uploads_backup_created=$uploads_file"
fi

find "$backup_dir" -type f \( -name "${POSTGRES_DB}_*.dump" -o -name "${POSTGRES_DB}_*.dump.sha256" \) -mtime +"$retention_days" -delete
find "$backup_dir" -type f \( -name "uploads_*.tar.gz" -o -name "uploads_*.tar.gz.sha256" \) -mtime +"$retention_days" -delete
echo "backup_created=$db_file"
