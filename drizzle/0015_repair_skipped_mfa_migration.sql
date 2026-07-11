-- Repair databases that skipped 0009 because its historical journal timestamp
-- is older than 0008. Keep this idempotent for databases where 0009 did run.
ALTER TABLE "user_mfa_config" ADD COLUMN IF NOT EXISTS "last_used_totp_counter" bigint;
