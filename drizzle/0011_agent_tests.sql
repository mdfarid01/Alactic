CREATE TYPE "public"."test_run_status" AS ENUM('running', 'passed', 'failed', 'error');--> statement-breakpoint
CREATE TABLE "agent_test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"question" text NOT NULL,
	"must_include" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expect_answer" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_test_cases_question_length" CHECK (char_length("agent_test_cases"."question") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "agent_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid,
	"question" text NOT NULL,
	"passed" boolean NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer_excerpt" text,
	"inference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"status" "test_run_status" DEFAULT 'running' NOT NULL,
	"total" integer NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_run_id_agent_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_case_id_agent_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."agent_test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_test_cases_agent_idx" ON "agent_test_cases" USING btree ("agent_id","org_id");--> statement-breakpoint
CREATE INDEX "agent_test_results_run_idx" ON "agent_test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_test_runs_agent_idx" ON "agent_test_runs" USING btree ("agent_id","started_at");