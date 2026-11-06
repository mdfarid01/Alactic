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
ALTER TABLE "org_digests" ADD CONSTRAINT "org_digests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_digests" ADD CONSTRAINT "org_digests_inference_id_inference_records_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;