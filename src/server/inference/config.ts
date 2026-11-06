import "server-only";
import type { Hex } from "viem";
import { env } from "@/server/env";
import { embeddingProvider } from "@/server/knowledge/config";
import type { RunAgentDeps } from "@/server/runtime/run-agent";
import { db } from "@/server/db/client";
import { getModelCatalog } from "./catalog";
import { RouterChatClient } from "./router-client";
import { chainServiceReader, verifyTeeSignature } from "./tee-verifier";

let serviceReader: ReturnType<typeof chainServiceReader> | undefined;

export function runtimeDeps(): RunAgentDeps {
  const e = env();
  serviceReader ??= chainServiceReader({ rpcUrl: e.ZG_CHAIN_RPC_URL, chainId: e.ZG_CHAIN_ID, contract: e.ZG_INFERENCE_CONTRACT as Hex });
  const router = new RouterChatClient({ baseUrl: e.ZG_ROUTER_BASE_URL, apiKey: e.ZG_ROUTER_API_KEY });
  return {
    db: db(),
    chat: router,
    transcriber: router,
    transcriptionModel: e.TRANSCRIPTION_MODEL,
    embedder: embeddingProvider(),
    dailyOrgLimit: e.INFERENCE_DAILY_ORG_LIMIT,
    modelSupports: async (modelId, parameter) => {
      const catalog = await getModelCatalog();
      return catalog.ok && (catalog.models.find((m) => m.id === modelId)?.supportedParameters.includes(parameter) ?? false);
    },
    verifyTee: (input) => verifyTeeSignature({ readService: serviceReader! }, input),
  };
}

export function inferenceConfigured(): boolean {
  return !!env().ZG_ROUTER_API_KEY;
}
