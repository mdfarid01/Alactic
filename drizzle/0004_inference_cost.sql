ALTER TABLE "inference_records" ADD COLUMN "cost_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "inference_records" ADD COLUMN "cost_unit" text;