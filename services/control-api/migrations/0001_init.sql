CREATE TABLE "app_members" (
	"app" text NOT NULL,
	"user_id" text NOT NULL,
	"org" text NOT NULL,
	"role" text NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "app_members_app_user_id_pk" PRIMARY KEY("app","user_id")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"slug" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"emoji" text,
	"color" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"ticket_seq" integer DEFAULT 0 NOT NULL,
	"version_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_status_check" CHECK ("apps"."status" in ('draft', 'live', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"env" text NOT NULL,
	"scope" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"period" text NOT NULL,
	"limit_usd" numeric(12, 4) NOT NULL,
	"spent_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_env_check" CHECK ("budgets"."env" in ('dev', 'prod')),
	CONSTRAINT "budgets_scope_check" CHECK ("budgets"."scope" in ('app', 'plan', 'user')),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" in ('day', 'month'))
);
--> statement-breakpoint
CREATE TABLE "builders" (
	"user_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builders_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "envs" (
	"app" text NOT NULL,
	"name" text NOT NULL,
	"active_version_id" uuid,
	"database_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envs_app_name_pk" PRIMARY KEY("app","name"),
	CONSTRAINT "envs_name_check" CHECK ("envs"."name" in ('dev', 'prod'))
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_app" text NOT NULL,
	"to_app" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_kind_check" CHECK ("grants"."kind" in ('MCP', 'A2A')),
	CONSTRAINT "grants_status_check" CHECK ("grants"."status" in ('pending', 'connected', 'rejected')),
	CONSTRAINT "grants_distinct_apps_check" CHECK ("grants"."from_app" <> "grants"."to_app")
);
--> statement-breakpoint
CREATE TABLE "improvement_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"app" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker" text,
	"branch" text,
	"version_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "improvement_runs_status_check" CHECK ("improvement_runs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"app" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"impact" text NOT NULL,
	"effort" text NOT NULL,
	"affects" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_impact_check" CHECK ("proposals"."impact" in ('High', 'Med', 'Low')),
	CONSTRAINT "proposals_effort_check" CHECK ("proposals"."effort" in ('S', 'M', 'L')),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('pending', 'approved', 'rejected', 'built'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"date" date NOT NULL,
	"summary" text NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_arn" text NOT NULL,
	"owner" text NOT NULL,
	"app" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_task_arn_unique" UNIQUE("task_arn"),
	CONSTRAINT "sandboxes_kind_check" CHECK ("sandboxes"."kind" in ('workspace', 'improvement'))
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"key" text NOT NULL,
	"type" text,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"route" text,
	"context" jsonb,
	"source" text DEFAULT 'in-app' NOT NULL,
	"votes" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text,
	"valid" boolean,
	"duplicate_of" uuid,
	"reporter" text,
	"reporter_org" text,
	"fixed_in" text,
	"triaged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_type_check" CHECK ("tickets"."type" is null or "tickets"."type" in ('bug', 'ux', 'feat', 'quality')),
	CONSTRAINT "tickets_source_check" CHECK ("tickets"."source" in ('in-app', 'email', 'chat', 'auto')),
	CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" in ('new', 'triaged', 'progress', 'done')),
	CONSTRAINT "tickets_priority_check" CHECK ("tickets"."priority" is null or "tickets"."priority" in ('high', 'med', 'low'))
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"env" text NOT NULL,
	"number" integer NOT NULL,
	"code_commit" text NOT NULL,
	"artifact_url" text NOT NULL,
	"config_version" text NOT NULL,
	"lambda_version" text NOT NULL,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema" jsonb,
	"policy" jsonb,
	"source_version_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_env_check" CHECK ("versions"."env" in ('dev', 'prod'))
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_builders_user_id_fk" FOREIGN KEY ("owner") REFERENCES "public"."builders"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envs" ADD CONSTRAINT "envs_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envs" ADD CONSTRAINT "envs_active_version_id_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_from_app_apps_slug_fk" FOREIGN KEY ("from_app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_to_app_apps_slug_fk" FOREIGN KEY ("to_app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_runs" ADD CONSTRAINT "improvement_runs_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_runs" ADD CONSTRAINT "improvement_runs_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_runs" ADD CONSTRAINT "improvement_runs_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_duplicate_of_tickets_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_app_apps_slug_fk" FOREIGN KEY ("app") REFERENCES "public"."apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_source_version_id_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_owner_idx" ON "apps" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "apps_handle_idx" ON "apps" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_subject_idx" ON "budgets" USING btree ("app","env","scope","subject","period");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_idx" ON "consents" USING btree ("user_id","app","client_id") WHERE "consents"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "consents_app_idx" ON "consents" USING btree ("app");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_open_link_idx" ON "grants" USING btree ("from_app","to_app","kind") WHERE "grants"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "grants_to_app_idx" ON "grants" USING btree ("to_app");--> statement-breakpoint
CREATE INDEX "improvement_runs_queue_idx" ON "improvement_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "improvement_runs_proposal_idx" ON "improvement_runs" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposals_report_idx" ON "proposals" USING btree ("report_id","position");--> statement-breakpoint
CREATE INDEX "reports_app_created_idx" ON "reports" USING btree ("app","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_owner_idx" ON "sandboxes" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_app_key_idx" ON "tickets" USING btree ("app","key");--> statement-breakpoint
CREATE INDEX "tickets_app_status_idx" ON "tickets" USING btree ("app","status");--> statement-breakpoint
CREATE INDEX "tickets_text_trgm_idx" ON "tickets" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "versions_app_env_number_idx" ON "versions" USING btree ("app","env","number");