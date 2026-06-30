WITH ranked_pending_invitations AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "workspace_id", lower("email")
			ORDER BY "created_at" DESC, "id" DESC
		) AS "rank"
	FROM "workspace_invitation"
	WHERE "status" = 'pending'
)
UPDATE "workspace_invitation"
SET "status" = 'revoked'
FROM ranked_pending_invitations
WHERE "workspace_invitation"."id" = ranked_pending_invitations."id"
	AND ranked_pending_invitations."rank" > 1;

CREATE UNIQUE INDEX "workspace_invitation_pending_email_unique_idx" ON "workspace_invitation" USING btree ("workspace_id",lower("email")) WHERE "workspace_invitation"."status" = 'pending';
