CREATE TYPE "public"."conversation_channel" AS ENUM('playground', 'web', 'widget', 'discord', 'slack', 'zendesk');--> statement-breakpoint
CREATE TYPE "public"."inference_status" AS ENUM('requested', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('router', 'independent');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('not_requested', 'verified', 'failed', 'unavailable');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"external_ref" text,
	"visitor_token_hash" text,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_unique" UNIQUE("id","agent_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "inference_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"config_id" uuid,
	"model_id" text NOT NULL,
	"trust_mode_requested" "trust_mode" NOT NULL,
	"verify_tee_requested" boolean NOT NULL,
	"status" "inference_status" DEFAULT 'requested' NOT NULL,
	"router_request_id" text,
	"chat_id" text,
	"provider_address" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_neuron" numeric(78, 0),
	"latency_ms" integer,
	"error_type" text,
	"error_code" text,
	"http_status" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"inference_id" uuid,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_content_length" CHECK (char_length("messages"."content") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "verification_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"inference_id" uuid NOT NULL,
	"method" "verification_method" NOT NULL,
	"status" "verification_status" NOT NULL,
	"signer_address" text,
	"details" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_records" ADD CONSTRAINT "inference_records_conversation_tenant_fk" FOREIGN KEY ("conversation_id","agent_id","org_id") REFERENCES "public"."conversations"("id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_tenant_fk" FOREIGN KEY ("conversation_id","agent_id","org_id") REFERENCES "public"."conversations"("id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records" ADD CONSTRAINT "verification_records_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_agent_recent_idx" ON "conversations" USING btree ("agent_id","last_message_at");--> statement-breakpoint
CREATE INDEX "inference_records_org_time_idx" ON "inference_records" USING btree ("org_id","requested_at");--> statement-breakpoint
CREATE INDEX "inference_records_agent_time_idx" ON "inference_records" USING btree ("agent_id","requested_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_time_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_records_inference_idx" ON "verification_records" USING btree ("inference_id");