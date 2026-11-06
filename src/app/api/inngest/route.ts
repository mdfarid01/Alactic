import { serve } from "inngest/next";
import { inngest } from "@/server/jobs/client";
import { functions } from "@/server/jobs/knowledge-ingest";

// Requests to this endpoint are authenticated by Inngest's signing key in production (cloud mode).
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
