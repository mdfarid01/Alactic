CREATE TYPE "public"."agent_status" AS ENUM('draft', 'published', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."agent_tone" AS ENUM('professional', 'friendly', 'concise', 'empathetic');--> statement-breakpoint
CREATE TYPE "public"."trust_mode" AS ENUM('private', 'verified', 'standard');--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"persona" text DEFAULT '' NOT NULL,
	"tone" "agent_tone" DEFAULT 'professional' NOT NULL,
	"language" text DEFAULT 'auto' NOT NULL,
	"fallback_message" text NOT NULL,
	"model_id" text NOT NULL,
	"trust_mode" "trust_mode" NOT NULL,
	"temperature" real DEFAULT 0.3 NOT NULL,
	"max_output_tokens" integer DEFAULT 1024 NOT NULL,
	"retrieval_top_k" integer DEFAULT 8 NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_configs_agent_version_unique" UNIQUE("agent_id","version"),
	CONSTRAINT "agent_configs_id_agent_unique" UNIQUE("id","agent_id"),
	CONSTRAINT "agent_configs_name_length" CHECK (char_length("agent_configs"."name") between 2 and 60),
	CONSTRAINT "agent_configs_description_length" CHECK (char_length("agent_configs"."description") <= 280),
	CONSTRAINT "agent_configs_instructions_length" CHECK (char_length("agent_configs"."instructions") <= 8000),
	CONSTRAINT "agent_configs_persona_length" CHECK (char_length("agent_configs"."persona") <= 500),
	CONSTRAINT "agent_configs_fallback_length" CHECK (char_length("agent_configs"."fallback_message") between 10 and 500),
	CONSTRAINT "agent_configs_temperature_range" CHECK ("agent_configs"."temperature" >= 0 and "agent_configs"."temperature" <= 1),
	CONSTRAINT "agent_configs_max_tokens_range" CHECK ("agent_configs"."max_output_tokens" between 128 and 4096),
	CONSTRAINT "agent_configs_top_k_range" CHECK ("agent_configs"."retrieval_top_k" between 1 and 20),
	CONSTRAINT "agent_configs_version_positive" CHECK ("agent_configs"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" "agent_status" DEFAULT 'draft' NOT NULL,
	"published_config_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug"),
	CONSTRAINT "agents_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "agents_slug_format" CHECK ("agents"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$')
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_one_draft_per_agent" ON "agent_configs" USING btree ("agent_id") WHERE "agent_configs"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_org_id_idx" ON "agents" USING btree ("org_id");--> statement-breakpoint
-- Hand-written (not expressible in the Drizzle schema):
-- 1. The published config must belong to the same agent.
ALTER TABLE "agents" ADD CONSTRAINT "agents_published_config_same_agent_fk" FOREIGN KEY ("published_config_id","id") REFERENCES "public"."agent_configs"("id","agent_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
-- 2. Published config versions are immutable; ownership/version columns never change on any row.
CREATE FUNCTION "agent_configs_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent_configs %: published versions are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.agent_id <> OLD.agent_id OR NEW.org_id <> OLD.org_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'agent_configs %: agent_id, org_id and version cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_configs_guard_update" BEFORE UPDATE ON "agent_configs" FOR EACH ROW EXECUTE FUNCTION "agent_configs_guard_update"();
