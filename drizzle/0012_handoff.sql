CREATE TYPE "public"."handoff_status" AS ENUM('open', 'resolved');--> statement-breakpoint
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
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_summary_inference_id_inference_records_id_fk" FOREIGN KEY ("summary_inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_conversation_tenant_fk" FOREIGN KEY ("conversation_id","agent_id","org_id") REFERENCES "public"."conversations"("id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_requests_org_status_idx" ON "handoff_requests" USING btree ("org_id","status","created_at");