CREATE TYPE "public"."connector_platform" AS ENUM('telegram', 'discord', 'slack', 'whatsapp', 'zendesk');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
ALTER TYPE "public"."conversation_channel" ADD VALUE 'telegram';--> statement-breakpoint
ALTER TYPE "public"."conversation_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
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
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_connections_agent_idx" ON "channel_connections" USING btree ("agent_id","org_id");--> statement-breakpoint
CREATE INDEX "connector_events_received_idx" ON "connector_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "conversations_external_ref_idx" ON "conversations" USING btree ("agent_id","channel","external_ref");