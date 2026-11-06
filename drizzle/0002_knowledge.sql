CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('website', 'file', 'faq', 'text');--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"heading_path" text,
	"page_from" integer,
	"page_to" integer,
	"token_count" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_document_index_unique" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"content" text NOT NULL,
	"page_offsets" jsonb,
	"content_sha256" text NOT NULL,
	"indexed_sha256" text,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_tenant_unique" UNIQUE("id","source_id","agent_id","org_id"),
	CONSTRAINT "knowledge_documents_source_key_unique" UNIQUE("source_id","external_key")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" "knowledge_source_type" NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"file_name" text,
	"file_mime" text,
	"file_size" integer,
	"crawl_options" jsonb,
	"status" "knowledge_source_status" DEFAULT 'queued' NOT NULL,
	"status_detail" text,
	"ingest_run_id" uuid,
	"document_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_tenant_unique" UNIQUE("id","agent_id","org_id"),
	CONSTRAINT "knowledge_sources_title_length" CHECK (char_length("knowledge_sources"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_tenant_fk" FOREIGN KEY ("document_id","source_id","agent_id","org_id") REFERENCES "public"."knowledge_documents"("id","source_id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_tenant_fk" FOREIGN KEY ("source_id","agent_id","org_id") REFERENCES "public"."knowledge_sources"("id","agent_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_agent_idx" ON "knowledge_chunks" USING btree ("agent_id","org_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_hnsw" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_sources_agent_idx" ON "knowledge_sources" USING btree ("agent_id","org_id");