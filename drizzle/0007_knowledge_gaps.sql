CREATE TYPE "public"."knowledge_gap_status" AS ENUM('open', 'answered', 'dismissed');--> statement-breakpoint
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
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_first_message_id_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_gaps_agent_status_idx" ON "knowledge_gaps" USING btree ("agent_id","status","last_asked_at");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_org_status_idx" ON "knowledge_gaps" USING btree ("org_id","status");