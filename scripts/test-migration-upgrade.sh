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

assert_attachment_deletion_outbox() {
	local target_url="$1"
	local target_label="$2"
	local schema_count
	schema_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT
			   (SELECT count(*)
			    FROM information_schema.columns
			    WHERE table_schema = 'public'
			      AND table_name = 'attachment_deletion'
			      AND column_name IN (
			        'attachment_id', 'workspace_id', 'expense_id', 'storage_key',
			        'size_bytes', 'sha256', 'status', 'not_before', 'next_attempt_at',
			        'attempt_count', 'claim_token', 'claim_expires_at', 'completed_at'
			      ))
			 + (SELECT count(*)
			    FROM information_schema.columns
			    WHERE table_schema = 'public'
			      AND table_name = 'expense_attachment'
			      AND column_name = 'deleted_at'
			      AND data_type = 'timestamp with time zone')
			 + (SELECT count(*)
			    FROM pg_constraint
			    WHERE conname IN (
			      'attachment_deletion_status_check',
			      'attachment_deletion_attempt_count_check',
			      'attachment_deletion_error_category_check'
			    ) AND contype = 'c' AND convalidated)
			 + (SELECT count(*)
			    FROM pg_indexes
			    WHERE schemaname = 'public'
			      AND tablename = 'attachment_deletion'
			      AND indexname IN (
			        'attachment_deletion_attachment_unique_idx',
			        'attachment_deletion_storage_key_unique_idx',
			        'attachment_deletion_due_idx'
			      ))
			 + (SELECT count(*)
			    FROM pg_proc
			    WHERE proname = 'enqueue_attachment_deletion_on_hard_delete')
			 + (SELECT count(*)
			    FROM pg_trigger
			    WHERE tgname = 'expense_attachment_enqueue_deletion_trigger'
			      AND NOT tgisinternal)"
	)"
	if [ "${schema_count}" != "22" ]; then
		echo "${target_label} does not have the durable attachment deletion outbox schema." >&2
		exit 1
	fi
}

assert_ofx_reconciliation() {
	local target_url="$1"
	local target_label="$2"
	local schema_count
	schema_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT
			   (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'bank_transaction'
			      AND column_name IN (
			        'workspace_id', 'uploaded_by_user_id', 'source_account_fingerprint',
			        'source_identity', 'source_checksum', 'provider_transaction_id',
			        'source_currency',
			        'posted_date', 'signed_amount_cents', 'description', 'status',
			        'expense_id', 'decided_by_user_id', 'decided_at'
			      ))
			 + (SELECT count(*) FROM pg_constraint
			    WHERE conname IN (
			      'bank_transaction_amount_cents_check',
			      'bank_transaction_status_check',
			      'bank_transaction_source_currency_check',
			      'bank_transaction_decision_check'
			    ) AND contype = 'c' AND convalidated)
			 + (SELECT count(*) FROM pg_indexes
			    WHERE schemaname = 'public' AND tablename = 'bank_transaction'
			      AND indexname IN (
			        'bank_transaction_workspace_source_unique_idx',
			        'bank_transaction_expense_unique_idx',
			        'bank_transaction_workspace_pending_idx'
			      ))
			 + (SELECT count(*) FROM pg_constraint
			    WHERE conname = 'bank_transaction_expense_id_expense_id_fk'
			      AND contype = 'f' AND confdeltype = 'n')"
	)"
	if [ "${schema_count}" != "22" ]; then
		echo "${target_label} does not have the guarded OFX reconciliation schema." >&2
		exit 1
	fi
}

assert_budget_alert_controls() {
	local target_url="$1"
	local target_label="$2"
	local schema_count
	schema_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT
			   (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'budget_alert_recipient'
			      AND column_name IN ('workspace_id', 'user_id', 'created_by_user_id')
			      AND is_nullable = 'NO')
			 + (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'budget_alert_delivery'
			      AND column_name IN (
			        'recipient_user_id', 'recipient_label_snapshot', 'category_id',
			        'category_name_snapshot', 'level', 'stage', 'last_error_category'
			      ))
			 + (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'budget_alert_preference'
			      AND column_name IN ('recipient_mode', 'escalate_over_budget')
			      AND is_nullable = 'NO')
			 + (SELECT count(*) FROM pg_constraint
			    WHERE conname IN (
			      'budget_alert_recipient_workspace_user_pk',
			      'budget_alert_recipient_created_by_user_id_user_id_fk',
			      'budget_alert_recipient_workspace_member_fk',
			      'budget_alert_delivery_level_check',
			      'budget_alert_delivery_stage_check',
			      'budget_alert_delivery_escalation_level_check',
			      'budget_alert_delivery_error_category_check',
			      'budget_alert_preference_recipient_mode_check'
			    ) AND convalidated)
			 + (SELECT count(*) FROM pg_indexes
			    WHERE schemaname = 'public'
			      AND indexname IN (
			        'budget_alert_delivery_workspace_month_recipient_unique_idx',
			        'budget_alert_delivery_alert_recipient_unique_idx',
			        'budget_alert_delivery_transition_recipient_unique_idx',
			        'budget_alert_delivery_workspace_history_idx',
			        'budget_alert_recipient_created_by_idx'
			      ))"
	)"
	if [ "${schema_count}" != "25" ]; then
		echo "${target_label} does not have the guarded budget-alert control schema." >&2
		exit 1
	fi

	local transition_index_count
	transition_index_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*) FROM pg_indexes
			 WHERE schemaname = 'public'
			   AND tablename = 'budget_alert_delivery'
			   AND indexname = 'budget_alert_delivery_transition_recipient_unique_idx'
			   AND indexdef ILIKE 'CREATE UNIQUE INDEX%workspace_id%period_month%category_id%recipient_user_id%stage%WHERE%level%is not null%'"
	)"
	if [ "${transition_index_count}" != "1" ]; then
		echo "${target_label} does not enforce one level per budget-alert transition stage." >&2
		exit 1
	fi

	local history_index_count
	history_index_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*) FROM pg_index i
			 JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
			 JOIN pg_class table_relation ON table_relation.oid = i.indrelid
			 JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
			 WHERE namespace.nspname = 'public'
			   AND table_relation.relname = 'budget_alert_delivery'
			   AND index_relation.relname = 'budget_alert_delivery_workspace_history_idx'
			   AND i.indoption::text = '0 3'
			   AND pg_get_indexdef(i.indexrelid) ILIKE '%workspace_id%id DESC%'"
	)"
	if [ "${history_index_count}" != "1" ]; then
		echo "${target_label} does not support descending budget-alert history cursors." >&2
		exit 1
	fi

	local escalation_constraint_count
	escalation_constraint_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*) FROM pg_constraint
			 WHERE conname = 'budget_alert_delivery_escalation_level_check'
			   AND contype = 'c'
			   AND convalidated
			   AND pg_get_constraintdef(oid) ILIKE '%stage%escalation%level%over%'"
	)"
	if [ "${escalation_constraint_count}" != "1" ]; then
		echo "${target_label} allows a non-over escalation delivery." >&2
		exit 1
	fi

	local foreign_key_delete_rules
	foreign_key_delete_rules="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT count(*) FROM pg_constraint
			 WHERE (conname = 'budget_alert_recipient_workspace_member_fk' AND confdeltype = 'c')
			    OR (conname = 'budget_alert_recipient_created_by_user_id_user_id_fk' AND confdeltype = 'r')"
	)"
	if [ "${foreign_key_delete_rules}" != "2" ]; then
		echo "${target_label} has incorrect budget-alert recipient deletion rules." >&2
		exit 1
	fi
}

assert_expense_trash() {
	local target_url="$1"
	local target_label="$2"
	local schema_count
	schema_count="$(
		psql "${target_url}" -v ON_ERROR_STOP=1 -Atqc \
			"SELECT
			   (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'expense'
			      AND column_name = 'trash_expires_at' AND data_type = 'timestamp with time zone')
			 + (SELECT count(*) FROM information_schema.columns
			    WHERE table_schema = 'public' AND table_name = 'attachment_deletion'
			      AND column_name = 'reason' AND is_nullable = 'NO')
			 + (SELECT count(*) FROM pg_constraint
			    WHERE conname IN ('expense_trash_timestamp_pair_check', 'attachment_deletion_reason_check')
			      AND contype = 'c' AND convalidated)
			 + (SELECT count(*) FROM pg_indexes
			    WHERE schemaname = 'public' AND tablename = 'expense'
			      AND indexname IN ('expense_workspace_trash_idx', 'expense_trash_expiry_idx'))"
	)"
	if [ "${schema_count}" != "6" ]; then
		echo "${target_label} does not have the recoverable expense-trash schema." >&2
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

# A pre-trash soft deletion is deliberately non-restorable after upgrade. Its
# attachment may already have been removed, so the migration must tombstone its
# metadata and preserve a durable deletion intent rather than promise recovery.
psql "${upgrade_database_url}" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "user" (id, name, email, email_verified)
VALUES ('expense-trash-migration-fixture', 'Trash fixture', 'expense-trash-migration-fixture@example.com', true);
WITH inserted_workspace AS (
	INSERT INTO workspace (name, created_by_user_id, currency)
	VALUES ('Trash migration fixture', 'expense-trash-migration-fixture', 'USD')
	RETURNING id
), inserted_category AS (
	INSERT INTO category (workspace_id, name, color)
	SELECT id, 'Legacy trash', '#123456' FROM inserted_workspace
	RETURNING id, workspace_id
), inserted_expense AS (
	INSERT INTO expense (
		workspace_id, category_id, created_by_user_id, description,
		amount_cents, currency, expense_date, deleted_at
	)
	SELECT workspace_id, id, 'expense-trash-migration-fixture', 'Legacy deleted expense',
		100, 'USD', '2026-07-01', '2026-07-02T00:00:00Z'::timestamptz
	FROM inserted_category
	RETURNING id, workspace_id
)
INSERT INTO expense_attachment (
	workspace_id, expense_id, uploaded_by_user_id, original_name, content_type,
	size_bytes, storage_key, sha256
)
SELECT workspace_id, id, 'expense-trash-migration-fixture', 'legacy.txt', 'text/plain',
	6, 'legacy/trash/legacy.txt', repeat('a', 64)
FROM inserted_expense;
SQL

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
assert_attachment_deletion_outbox "${upgrade_database_url}" "Upgraded database"
assert_ofx_reconciliation "${upgrade_database_url}" "Upgraded database"
assert_budget_alert_controls "${upgrade_database_url}" "Upgraded database"
assert_expense_trash "${upgrade_database_url}" "Upgraded database"

legacy_trash_count="$(
	psql "${upgrade_database_url}" -v ON_ERROR_STOP=1 -Atqc \
		"SELECT count(*)
		 FROM expense e
		 JOIN expense_attachment a ON a.expense_id = e.id
		 JOIN attachment_deletion d ON d.attachment_id = a.id
		 WHERE e.description = 'Legacy deleted expense'
		   AND e.trash_expires_at = e.deleted_at
		   AND a.deleted_at = e.deleted_at
		   AND d.reason = 'attachment_deleted'"
)"
if [ "${legacy_trash_count}" != "1" ]; then
	echo "Upgraded legacy trash row became restorable or lost its attachment intent." >&2
	exit 1
fi

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
assert_attachment_deletion_outbox "${fresh_database_url}" "Fresh database"
assert_ofx_reconciliation "${fresh_database_url}" "Fresh database"
assert_budget_alert_controls "${fresh_database_url}" "Fresh database"
assert_expense_trash "${fresh_database_url}" "Fresh database"

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
