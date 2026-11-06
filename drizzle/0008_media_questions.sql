ALTER TABLE "messages" ADD COLUMN "attachment_kind" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pre_inference_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pre_inference_id_inference_records_id_fk" FOREIGN KEY ("pre_inference_id") REFERENCES "public"."inference_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_kind" CHECK ("messages"."attachment_kind" is null or "messages"."attachment_kind" in ('voice', 'image'));