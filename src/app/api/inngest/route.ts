import { serve } from "inngest/next";
import { inngest } from "@/server/jobs/client";
import { agentTests } from "@/server/jobs/agent-tests";
import { connectorMessage } from "@/server/jobs/connector-message";
import { dailyDigest } from "@/server/jobs/daily-digest";
import { functions as knowledgeFunctions } from "@/server/jobs/knowledge-ingest";

// Requests to this endpoint are authenticated by Inngest's signing key in production (cloud mode).
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions: [...knowledgeFunctions, connectorMessage, agentTests, dailyDigest] });
