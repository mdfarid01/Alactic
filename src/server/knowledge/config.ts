import "server-only";
import { env } from "@/server/env";
import { ZeroGEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { FirecrawlCrawler } from "./firecrawl";

export function embeddingProvider(): EmbeddingProvider {
  const e = env();
  return new ZeroGEmbeddingProvider({
    baseUrl: e.ZG_ROUTER_BASE_URL,
    apiKey: e.ZG_ROUTER_API_KEY,
    model: e.EMBEDDING_MODEL,
    trustMode: e.EMBEDDING_TRUST_MODE,
    sendDimensions: e.EMBEDDING_SEND_DIMENSIONS,
  });
}

export function crawler(): FirecrawlCrawler {
  return new FirecrawlCrawler(env().FIRECRAWL_API_KEY);
}

/** Non-secret status for the UI. */
export function knowledgeConfigStatus() {
  const e = env();
  return {
    embeddingModel: e.EMBEDDING_MODEL,
    embeddingTrustMode: e.EMBEDDING_TRUST_MODE,
    embeddingsConfigured: !!e.ZG_ROUTER_API_KEY,
    crawlingConfigured: !!e.FIRECRAWL_API_KEY,
  };
}
