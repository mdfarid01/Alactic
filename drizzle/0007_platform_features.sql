CREATE TYPE "public"."connector_platform" AS ENUM('telegram', 'discord', 'slack', 'whatsapp', 'zendesk');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."knowledge_gap_status" AS ENUM('open', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."test_run_status" AS ENUM('running', 'passed', 'failed', 'error');--> statement-breakpoint
ALTER TYPE "public"."conversation_channel" ADD VALUE 'telegram';--> statement-breakpoint
ALTER TYPE "public"."conversation_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
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
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"platform" "connector_platform" NOT NULL,
	"status" "connector_status" DEFAULT 'active' NOT NULL,
	"label" text NOT NULL,
	"external_id" text NOT NULL,
	"delivery_mode" text DEFAULT 'webhook' NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"last_error" text,
	"last_event_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_platform_external_unique" UNIQUE("platform","external_id"),
	CONSTRAINT "channel_connections_label_length" CHECK (char_length("channel_connections"."label") between 1 and 120),
	CONSTRAINT "channel_connections_delivery_mode" CHECK ("channel_connections"."delivery_mode" in ('webhook', 'polling'))
);
--> statement-breakpoint
CREATE TABLE "connector_events" (
	"connection_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_events_connection_id_event_key_pk" PRIMARY KEY("connection_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "handoff_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"contact" text,
	"note" text,
	"summary" text,
	"summary_inference_id" uuid,
	"status" "handoff_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "handoff_requests_contact_length" CHECK ("handoff_requests"."contact" is null or char_length("handoff_requests"."contact") <= 200),
	CONSTRAINT "handoff_requests_note_length" CHECK ("handoff_requests"."note" is null or char_length("handoff_requests"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "knowledge_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"first_message_id" uuid,
	"question" text NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"ask_count" integer DEFAULT 1 NOT NULL,
	"status" "knowledge_gap_status" DEFAULT 'open' NOT NULL,
	"answer_source_id" uuid,
	"first_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "knowledge_gaps_question_length" CHECK (char_length("knowledge_gaps"."question") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "org_digests" (
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"content" text NOT NULL,
	"stats" jsonb NOT NULL,
	"inference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_digests_org_id_day_pk" PRIMARY KEY("org_id","day"),
	CONSTRAINT "org_digests_day_format" CHECK ("org_digests"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
ALTER TABLE "inference_records" ADD COLUMN "answer_sha256" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_kind" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pre_inference_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_run_id_agent_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_case_id_agent_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."agent_test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_results" ADD CONSTRAINT "agent_test_results_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_summary_inference_id_inference_records_id_fk" FOREIGN KEY ("summary_inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_conversation_tenant_fk" FOREIGN KEY ("conversation_id","agent_id","org_id") REFERENCES "public"."conversations"("id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_first_message_id_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_digests" ADD CONSTRAINT "org_digests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_digests" ADD CONSTRAINT "org_digests_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_test_cases_agent_idx" ON "agent_test_cases" USING btree ("agent_id","org_id");--> statement-breakpoint
CREATE INDEX "agent_test_results_run_idx" ON "agent_test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_test_runs_agent_idx" ON "agent_test_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "channel_connections_agent_idx" ON "channel_connections" USING btree ("agent_id","org_id");--> statement-breakpoint
CREATE INDEX "connector_events_received_idx" ON "connector_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "handoff_requests_org_status_idx" ON "handoff_requests" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_agent_status_idx" ON "knowledge_gaps" USING btree ("agent_id","status","last_asked_at");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_org_status_idx" ON "knowledge_gaps" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pre_inference_id_inference_records_id_fk" FOREIGN KEY ("pre_inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_external_ref_idx" ON "conversations" USING btree ("agent_id","channel","external_ref");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_kind" CHECK ("messages"."attachment_kind" is null or "messages"."attachment_kind" in ('voice', 'image'));