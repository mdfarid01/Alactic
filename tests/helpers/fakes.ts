import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@/server/db/schema";
import type { EmbeddingProvider } from "@/server/knowledge/embeddings";
import type { Crawler, CrawledPage, CrawlJobState } from "@/server/knowledge/firecrawl";

/**
 * Deterministic test embedder: hashed bag-of-words, L2-normalized. Texts sharing words get high cosine similarity,
 * so retrieval ranking is meaningful without calling a real model. TEST USE ONLY.
 */
export class HashingEmbedder implements EmbeddingProvider {
  readonly trustMode = "private" as const;
  calls = 0;
  constructor(readonly model = "test-hash-embedder") {}
  private vec(text: string) {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
      const h = createHash("sha256").update(word).digest();
      v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
  async embedDocuments(texts: string[]) {
    this.calls++;
    return texts.map((t) => this.vec(t));
  }
  async embedQuery(text: string) {
    return this.vec(text);
  }
}

export class FakeCrawler implements Crawler {
  constructor(public pages: CrawledPage[]) {}
  async start() {
    return "job-1";
  }
  async check(): Promise<CrawlJobState> {
    return { state: "completed", pages: this.pages };
  }
}

import type { ChatClient, ChatRequest, ChatResult } from "@/server/inference/router-client";

/** Scriptable fake 0G Router client. TEST USE ONLY. */
export class FakeChat implements ChatClient {
  requests: ChatRequest[] = [];
  constructor(public respond: (req: ChatRequest) => Promise<Partial<ChatResult>> | Partial<ChatResult>) {}
  async complete(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const r = await this.respond(req);
    const verifyTeeRequested = req.trustMode !== "standard";
    return {
      content: "",
      chatId: "chat-1",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 42,
      verifyTeeRequested,
      ...r,
      trace: { requestId: "req-1", provider: "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250", cost: { amount: "20", unit: "usd_micro" }, teeVerified: verifyTeeRequested ? true : null, ...(r.trace ?? {}) },
    };
  }
}
