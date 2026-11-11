CREATE TABLE "qa_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"env" text NOT NULL,
	"version_id" uuid,
	"status" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "qa_runs_env_check" CHECK ("qa_runs"."env" in ('dev', 'prod')),
	CONSTRAINT "qa_runs_status_check" CHECK ("qa_runs"."status" in ('passed', 'failed', 'error'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"action" text NOT NULL,
	"args" text,
	"user_id" text,
	"status" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"caller_kind" text DEFAULT 'user' NOT NULL,
	"caller_id" text,
	"caller_name" text,
	"consent_id" uuid,
	"note" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_env_check" CHECK ("runs"."env" in ('dev', 'prod')),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('ok', 'blocked', 'error')),
	CONSTRAINT "runs_caller_kind_check" CHECK ("runs"."caller_kind" in ('user', 'agent', 'app'))
);
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "status" text DEFAULT 'deployed' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "caller_token_ref" text;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_consent_id_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_runs_app_started_idx" ON "qa_runs" USING btree ("app","started_at");--> statement-breakpoint
CREATE INDEX "runs_app_at_idx" ON "runs" USING btree ("app","at");--> statement-breakpoint
CREATE INDEX "runs_app_caller_at_idx" ON "runs" USING btree ("app","caller_kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_one_draft_idx" ON "versions" USING btree ("app","env") WHERE "versions"."status" = 'draft';--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_status_check" CHECK ("versions"."status" in ('draft', 'deployed'));