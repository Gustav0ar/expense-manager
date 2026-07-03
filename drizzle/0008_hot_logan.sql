CREATE TABLE "email_verification_throttle" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"limit_reached_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_verification_throttle" ADD CONSTRAINT "email_verification_throttle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_verification_throttle_email_idx" ON "email_verification_throttle" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_verification_throttle_delete_after_idx" ON "email_verification_throttle" USING btree ("delete_after");