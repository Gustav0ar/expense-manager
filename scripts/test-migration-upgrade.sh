#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_url="${DATABASE_URL:?DATABASE_URL is required}"
database_suffix="${$}_$(date +%s)"
upgrade_database="expense_manager_migration_test_${database_suffix}_upgrade"
fresh_database="expense_manager_migration_test_${database_suffix}_fresh"
temp_root="$(mktemp -d "${repo_root}/.migration-test.XXXXXX")"
legacy_migrations="${temp_root}/drizzle"
legacy_config="${temp_root}/drizzle.config.ts"
upgrade_database_created=false
fresh_database_created=false

for database_name in "${upgrade_database}" "${fresh_database}"; do
	if ! printf '%s\n' "${database_name}" | grep -Eq '^expense_manager_migration_test_[0-9]+_[0-9]+_(upgrade|fresh)$'; then
		echo "Refusing to use unsafe migration-test database name: ${database_name}" >&2
		exit 1
	fi
done

maintenance_url="$(
	DATABASE_URL="${database_url}" node -e '
		const url = new URL(process.env.DATABASE_URL);
		url.pathname = "/postgres";
		console.log(url.toString());
	'
)"
upgrade_database_url="$(
	DATABASE_URL="${database_url}" TEMP_DATABASE="${upgrade_database}" node -e '
		const url = new URL(process.env.DATABASE_URL);
		url.pathname = `/${process.env.TEMP_DATABASE}`;
		console.log(url.toString());
	'
)"
fresh_database_url="$(
	DATABASE_URL="${database_url}" TEMP_DATABASE="${fresh_database}" node -e '
		const url = new URL(process.env.DATABASE_URL);
		url.pathname = `/${process.env.TEMP_DATABASE}`;
		console.log(url.toString());
	'
)"

cleanup() {
	if [ "${fresh_database_created}" = true ]; then
		dropdb --if-exists --force --maintenance-db="${maintenance_url}" "${fresh_database}" >/dev/null
		fresh_database_created=false
	fi
	if [ "${upgrade_database_created}" = true ]; then
		dropdb --if-exists --force --maintenance-db="${maintenance_url}" "${upgrade_database}" >/dev/null
		upgrade_database_created=false
	fi
	rm -rf "${temp_root}"
}
trap cleanup EXIT INT TERM

assert_money_constraints() {
	local target_url="$1"
	local target_label="$2"
	local constraint_count
	constraint_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*)
			 FROM pg_constraint
			 WHERE conname IN (
			   'category_budget_amount_cents_check',
			   'expense_amount_cents_check',
			   'recurring_expense_amount_cents_check'
			 )
			 AND contype = 'c'
			 AND convalidated
			 AND position('> 0' in pg_get_constraintdef(oid)) > 0
			 AND position('100000000000' in pg_get_constraintdef(oid)) > 0"
	)"
	if [ "${constraint_count}" != "3" ]; then
		echo "${target_label} does not have all three validated money boundaries." >&2
		exit 1
	fi
}

assert_invitation_delivery_outbox() {
	local target_url="$1"
	local target_label="$2"
	local schema_count
	schema_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT
			   (SELECT count(*)
			    FROM information_schema.columns
			    WHERE table_schema = 'public'
			      AND table_name = 'workspace_invitation_delivery'
			      AND column_name IN (
			        'invitation_id', 'encrypted_token', 'status', 'claim_token',
			        'claim_expires_at', 'attempt_count', 'last_error_category'
			      ))
			 + (SELECT count(*)
			    FROM pg_constraint
			    WHERE conname IN (
			      'workspace_invitation_delivery_status_check',
			      'workspace_invitation_delivery_attempt_count_check',
			      'workspace_invitation_delivery_error_category_check'
			    )
			      AND contype = 'c'
			      AND convalidated)
			 + (SELECT count(*)
			    FROM pg_indexes
			    WHERE schemaname = 'public'
			      AND tablename = 'workspace_invitation_delivery'
			      AND indexname IN (
			        'workspace_invitation_delivery_invitation_unique_idx',
			        'workspace_invitation_delivery_claim_expires_at_idx'
			      ))"
	)"
	if [ "${schema_count}" != "12" ]; then
		echo "${target_label} does not have the durable invitation outbox schema." >&2
		exit 1
	fi

	local plaintext_column_count
	plaintext_column_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*)
			 FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND table_name = 'workspace_invitation_delivery'
			   AND column_name IN ('token', 'raw_token', 'plaintext_token')"
	)"
	if [ "${plaintext_column_count}" != "0" ]; then
		echo "${target_label} exposes a plaintext invitation token column." >&2
		exit 1
	fi
}

mkdir -p "${legacy_migrations}/meta"
cp "${repo_root}"/drizzle/000[0-8]_*.sql "${legacy_migrations}/"

JOURNAL_SOURCE="${repo_root}/drizzle/meta/_journal.json" \
	JOURNAL_TARGET="${legacy_migrations}/meta/_journal.json" \
	node <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(process.env.JOURNAL_SOURCE, 'utf8'));
source.entries = source.entries.filter((entry) => entry.idx <= 8);
writeFileSync(process.env.JOURNAL_TARGET, `${JSON.stringify(source, null, 2)}\n`);
NODE

cat > "${legacy_config}" <<'EOF'
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = process.env.MIGRATION_TEST_OUT;

if (!databaseUrl) throw new Error('DATABASE_URL is not set');
if (!migrationsFolder) throw new Error('MIGRATION_TEST_OUT is not set');

export default defineConfig({
	dialect: 'postgresql',
	out: migrationsFolder,
	dbCredentials: { url: databaseUrl }
});
EOF

upgrade_database_created=true
createdb --maintenance-db="${maintenance_url}" "${upgrade_database}"

echo "Applying the historical 0000-0008 migration set to ${upgrade_database}."
DATABASE_URL="${upgrade_database_url}" MIGRATION_TEST_OUT="${legacy_migrations}" \
	pnpm exec drizzle-kit migrate --config "${legacy_config}"

missing_before_repair="$(
	psql "${upgrade_database_url}" -v ON_ERROR_STOP=1 -Atqc \
		"SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_mfa_config' AND column_name = 'last_used_totp_counter'"
)"
if [ "${missing_before_repair}" != "0" ]; then
	echo "Expected the 0008 fixture to omit last_used_totp_counter." >&2
	exit 1
fi

echo "Applying the complete migration set to the 0008 database."
DATABASE_URL="${upgrade_database_url}" pnpm exec drizzle-kit migrate --config "${repo_root}/drizzle.config.ts"

column_count="$(
	psql "${upgrade_database_url}" -v ON_ERROR_STOP=1 -Atqc \
		"SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_mfa_config' AND column_name = 'last_used_totp_counter' AND data_type = 'bigint'"
)"
if [ "${column_count}" != "1" ]; then
	echo "Migration repair did not create last_used_totp_counter as bigint." >&2
	exit 1
fi

echo "Reapplying the complete migration set to verify idempotency."
DATABASE_URL="${upgrade_database_url}" pnpm exec drizzle-kit migrate --config "${repo_root}/drizzle.config.ts"
assert_money_constraints "${upgrade_database_url}" "Upgraded database"
assert_invitation_delivery_outbox "${upgrade_database_url}" "Upgraded database"

fresh_database_created=true
createdb --maintenance-db="${maintenance_url}" "${fresh_database}"

echo "Applying the complete migration set to fresh database ${fresh_database}."
DATABASE_URL="${fresh_database_url}" pnpm exec drizzle-kit migrate --config "${repo_root}/drizzle.config.ts"

fresh_column_count="$(
	psql "${fresh_database_url}" -v ON_ERROR_STOP=1 -Atqc \
		"SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_mfa_config' AND column_name = 'last_used_totp_counter' AND data_type = 'bigint'"
)"
if [ "${fresh_column_count}" != "1" ]; then
	echo "Fresh migration did not create last_used_totp_counter as bigint." >&2
	exit 1
fi

echo "Reapplying the complete migration set to the fresh database."
DATABASE_URL="${fresh_database_url}" pnpm exec drizzle-kit migrate --config "${repo_root}/drizzle.config.ts"
assert_money_constraints "${fresh_database_url}" "Fresh database"
assert_invitation_delivery_outbox "${fresh_database_url}" "Fresh database"

cleanup
trap - EXIT INT TERM

remaining_databases="$(
	psql "${maintenance_url}" -v ON_ERROR_STOP=1 -Atqc \
		"SELECT count(*) FROM pg_database WHERE datname IN ('${upgrade_database}', '${fresh_database}')"
)"
if [ "${remaining_databases}" != "0" ]; then
	echo "Temporary migration-test databases were not removed." >&2
	exit 1
fi

echo "Migration upgrade test passed and temporary database cleanup was verified."
