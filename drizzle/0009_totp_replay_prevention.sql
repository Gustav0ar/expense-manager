-- Add last_used_totp_counter to user_mfa_config for TOTP replay prevention.
-- NULL means no code has been used yet (safe default for existing rows).
ALTER TABLE "user_mfa_config" ADD COLUMN "last_used_totp_counter" bigint;
