# Plan 010: Make attachment deletion and backups recoverable

> **Executor instructions**: Treat existing uploads and backups as irreplaceable data. Never delete a live file during migration or testing outside a disposable upload directory.
>
> **Drift check (run first)**: `git diff --stat 00e51f5..HEAD -- src/lib/server/services/attachments.ts src/lib/server/services/expenses.ts src/lib/server/db/schema.ts src/lib/server/background-jobs.ts scripts/backup.sh scripts/ops/recovery-drill.sh docker-compose.yml docs`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/001-repair-migration-ledger.md, plans/003-expand-coverage-scope.md, plans/006-atomic-audit-events.md
- **Category**: bug, operations
- **Planned at**: commit `00e51f5`, 2026-07-10

## Why this matters

Database and upload backups are captured at different times, while attachment deletion removes metadata first and silently ignores storage failure. A concurrent deletion can leave a database backup referencing a file absent from its upload archive; failed deletions accumulate undetectable orphan files.

## Current state

- `scripts/backup.sh:65-82`: runs `pg_dump`, then archives uploads.
- `src/lib/server/services/attachments.ts:178-197`: deletes DB row/audit, then suppresses filesystem errors.
- `src/lib/server/services/expenses.ts:644-677`: expense deletion repeats post-commit best-effort file deletion.
- Upload creation already uses temp file, atomic rename, DB transaction and rollback cleanup (`attachments.ts:67-108`).

## Commands you will need

Use the `AGENTS.md` Compose exec wrapper. Run migrations twice, targeted attachment/background-job integration tests with disposable upload directories, `bash -n scripts/*.sh`, the disposable recovery drill, attachment E2E and `pnpm verify`; all must exit 0.

## Scope

**In scope**:

- durable attachment deletion/tombstone schema and forward migration
- deletion worker/reconciler with advisory lock and metrics/health
- backup/recovery scripts and docs
- disposable-filesystem unit/integration/E2E and recovery-drill coverage

**Out of scope**:

- object-storage migration
- changing the 2 MB/type policy
- deleting unrecognized files automatically without a quarantine/report phase

## Git workflow

- Branch: `fix/010-attachment-lifecycle`
- One commit: `fix(storage): make attachment lifecycle recoverable`

## Steps

### 1. Introduce durable deletion intent

In the same transaction that removes/hides attachment metadata, enqueue a deletion record containing storage key, workspace/entity references, not-before time, attempts and status. Keep files for a grace period longer than the maximum backup capture duration. Do not expose deleted attachments for download.

**Verify**: transaction rollback retains both metadata and absence of deletion intent; commit creates exactly one intent.

### 2. Add an idempotent deletion worker and reconciler

Claim due deletions with multi-instance-safe locking. Treat missing files as success, record other failures and retry with a cap/backoff. Add a report-only reconciliation mode comparing DB keys, pending deletions and disk; never auto-delete unknown files initially.

**Verify**: tests cover success, missing file, permission-like failure, retry, concurrent workers and path traversal rejection.

### 3. Make backup consistency explicit

Change backup ordering/protocol so every DB-referenced file at the logical DB snapshot is guaranteed to remain during the upload archive. Use the deletion grace guarantee plus a manifest/check that verifies all attachment keys from the dump/current snapshot are present before uploading. Document the consistency model and failure response.

Extend `recovery-drill.sh` to restore a disposable snapshot and verify attachment metadata, file presence, size and checksum.

**Verify**: a test that uploads/deletes during backup restores without missing referenced files; recovery drill exits 0.

### 4. Expose health and run full gates

Add pending/failed deletion counts and last-success state without leaking paths. Update operations/disaster-recovery docs.

**Verify**: `pnpm verify` and shell syntax/compose tests pass.

## Test plan

- Filesystem tests cover create, tombstone, grace period, retry, missing file, checksum and unsafe path.
- Database tests cover atomic intent, concurrent workers and restored attachment cancellation.
- Backup race fixture performs upload/delete during capture and validates restored references/checksums.
- Browser E2E confirms download/delete behavior remains compatible.

## Done criteria

- [ ] File deletion is durable, retryable and observable.
- [ ] Backups cannot contain DB references to absent attachment files under the documented concurrency model.
- [ ] Recovery drill verifies checksums.
- [ ] Existing upload/download/delete UX remains compatible.
- [ ] Full verify passes.

## STOP conditions

- Any migration or worker could delete existing files without a verified DB intent.
- Backup consistency cannot be proven without a deployment-wide maintenance window; stop and propose that window explicitly.
- Tests require the real production upload directory or backup repository.

## Maintenance notes

Keep unknown-file reconciliation report-only until operators have reviewed it in production. Grace duration must remain longer than the worst observed backup duration.
