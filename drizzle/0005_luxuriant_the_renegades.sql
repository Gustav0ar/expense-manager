CREATE TABLE "cost_center" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_center_name_check" CHECK (length(btrim("cost_center"."name")) between 2 and 120)
);
--> statement-breakpoint
CREATE TABLE "payment_method" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_method_name_check" CHECK (length(btrim("payment_method"."name")) between 2 and 80)
);
--> statement-breakpoint
CREATE TABLE "vendor" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_name_check" CHECK (length(btrim("vendor"."name")) between 2 and 120)
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "payment_method_id" bigint;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "vendor_id" bigint;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "cost_center_id" bigint;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD COLUMN "payment_method_id" bigint;--> statement-breakpoint
ALTER TABLE "cost_center" ADD CONSTRAINT "cost_center_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_center_workspace_name_unique_idx" ON "cost_center" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "cost_center_workspace_active_idx" ON "cost_center" USING btree ("workspace_id","is_archived","name");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_workspace_name_unique_idx" ON "payment_method" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "payment_method_workspace_active_idx" ON "payment_method" USING btree ("workspace_id","is_archived","name");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_workspace_name_unique_idx" ON "vendor" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "vendor_workspace_active_idx" ON "vendor" USING btree ("workspace_id","is_archived","name");--> statement-breakpoint
INSERT INTO "payment_method" ("workspace_id", "name")
SELECT source.workspace_id, min(source.name) AS name
FROM (
	SELECT workspace_id, regexp_replace(btrim(payment_method), '[[:space:]]+', ' ', 'g') AS name
	FROM expense
	WHERE nullif(btrim(payment_method), '') IS NOT NULL
	UNION ALL
	SELECT workspace_id, regexp_replace(btrim(payment_method), '[[:space:]]+', ' ', 'g') AS name
	FROM recurring_expense
	WHERE nullif(btrim(payment_method), '') IS NOT NULL
) source
WHERE length(source.name) BETWEEN 2 AND 80
GROUP BY source.workspace_id, lower(source.name)
ON CONFLICT ("workspace_id", lower("name")) DO NOTHING;--> statement-breakpoint
INSERT INTO "vendor" ("workspace_id", "name")
SELECT source.workspace_id, min(source.name) AS name
FROM (
	SELECT workspace_id, regexp_replace(btrim(vendor), '[[:space:]]+', ' ', 'g') AS name
	FROM expense
	WHERE nullif(btrim(vendor), '') IS NOT NULL
) source
WHERE length(source.name) BETWEEN 2 AND 120
GROUP BY source.workspace_id, lower(source.name)
ON CONFLICT ("workspace_id", lower("name")) DO NOTHING;--> statement-breakpoint
INSERT INTO "cost_center" ("workspace_id", "name")
SELECT source.workspace_id, min(source.name) AS name
FROM (
	SELECT workspace_id, regexp_replace(btrim(cost_center), '[[:space:]]+', ' ', 'g') AS name
	FROM expense
	WHERE nullif(btrim(cost_center), '') IS NOT NULL
) source
WHERE length(source.name) BETWEEN 2 AND 120
GROUP BY source.workspace_id, lower(source.name)
ON CONFLICT ("workspace_id", lower("name")) DO NOTHING;--> statement-breakpoint
UPDATE "expense" e
SET "payment_method_id" = pm.id,
	"payment_method" = pm.name
FROM "payment_method" pm
WHERE pm.workspace_id = e.workspace_id
	AND lower(pm.name) = lower(regexp_replace(btrim(e.payment_method), '[[:space:]]+', ' ', 'g'))
	AND e.payment_method_id IS NULL
	AND nullif(btrim(e.payment_method), '') IS NOT NULL;--> statement-breakpoint
UPDATE "expense" e
SET "vendor_id" = v.id,
	"vendor" = v.name
FROM "vendor" v
WHERE v.workspace_id = e.workspace_id
	AND lower(v.name) = lower(regexp_replace(btrim(e.vendor), '[[:space:]]+', ' ', 'g'))
	AND e.vendor_id IS NULL
	AND nullif(btrim(e.vendor), '') IS NOT NULL;--> statement-breakpoint
UPDATE "expense" e
SET "cost_center_id" = cc.id,
	"cost_center" = cc.name
FROM "cost_center" cc
WHERE cc.workspace_id = e.workspace_id
	AND lower(cc.name) = lower(regexp_replace(btrim(e.cost_center), '[[:space:]]+', ' ', 'g'))
	AND e.cost_center_id IS NULL
	AND nullif(btrim(e.cost_center), '') IS NOT NULL;--> statement-breakpoint
UPDATE "recurring_expense" re
SET "payment_method_id" = pm.id,
	"payment_method" = pm.name
FROM "payment_method" pm
WHERE pm.workspace_id = re.workspace_id
	AND lower(pm.name) = lower(regexp_replace(btrim(re.payment_method), '[[:space:]]+', ' ', 'g'))
	AND re.payment_method_id IS NULL
	AND nullif(btrim(re.payment_method), '') IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payment_method_id_payment_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_cost_center_id_cost_center_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_center"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_payment_method_id_payment_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_payment_method_idx" ON "expense" USING btree ("payment_method_id");--> statement-breakpoint
CREATE INDEX "expense_vendor_idx" ON "expense" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "expense_cost_center_idx" ON "expense" USING btree ("cost_center_id");--> statement-breakpoint
CREATE INDEX "recurring_expense_payment_method_idx" ON "recurring_expense" USING btree ("payment_method_id");
