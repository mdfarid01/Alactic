import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/server/db/schema";

export type EmbeddingTrustMode = "private" | "verified" | "standard";

export interface EmbeddingProvider {
  readonly model: string;
  readonly trustMode: EmbeddingTrustMode;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export type EmbeddingErrorCode =
  | "not_configured"
  | "auth"
  | "insufficient_balance"
  | "rate_limited"
  | "no_provider_for_trust_mode"
  | "provider_unavailable"
  | "bad_response"
  | "request_failed";

/** `retryable` tells the job runner whether retrying the same request can help. */
export class EmbeddingError extends Error {
  constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

/**
 * Qwen3-Embedding models are instruction-aware: per the 0G catalog description, queries should be prefixed with
 * "Instruct: <task>\nQuery: " while documents need no prefix.
 */
const QUERY_INSTRUCTION =
  "Instruct: Given a customer support question, retrieve passages from the company's knowledge base that answer it\nQuery: ";

export type ZeroGEmbeddingConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  trustMode: EmbeddingTrustMode;
  /** Send `dimensions` (only for models that support it, e.g. qwen3.7-text-embedding). */
  sendDimensions: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Embeddings through the 0G Compute Router's OpenAI-compatible endpoint.
 * The trust mode header is always sent; the Router never falls back to a lower tier (503 instead), and neither do we.
 */
export class ZeroGEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly trustMode: EmbeddingTrustMode;
  constructor(private readonly config: ZeroGEmbeddingConfig) {
    this.model = config.model;
    this.trustMode = config.trustMode;
  }

  async embedDocuments(texts: string[]) {
    return this.request(texts);
  }

  async embedQuery(text: string) {
    const prefix = this.model.startsWith("qwen3-embedding") ? QUERY_INSTRUCTION : "";
    return (await this.request([prefix + text]))[0];
  }

  private async request(input: string[]): Promise<number[][]> {
    if (!this.config.apiKey) {
      throw new EmbeddingError(
        "not_configured",
        "Embeddings aren't configured yet (missing 0G Router API key). Sources will be indexed once it's set.",
        false,
      );
    }
    const doFetch = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "x-0g-provider-trust-mode": this.trustMode,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          encoding_format: "float",
          ...(this.config.sendDimensions ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
        }),
      });
    } catch {
      throw new EmbeddingError("request_failed", "Couldn't reach the 0G Router.", true);
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      if (res.status === 401 || res.status === 403) throw new EmbeddingError("auth", "The 0G Router rejected the API key.", false);
      if (res.status === 402) throw new EmbeddingError("insufficient_balance", "The 0G Router account has insufficient balance.", false);
      if (res.status === 429) throw new EmbeddingError("rate_limited", "Rate limited by the 0G Router.", true, retryAfter);
      if (res.status === 503 && code === "no_provider_for_trust_mode") {
        throw new EmbeddingError(
          "no_provider_for_trust_mode",
          `No ${this.trustMode} embedding provider is available right now. Indexing will not fall back to a less private mode.`,
          true,
        );
      }
      if (res.status >= 500) throw new EmbeddingError("provider_unavailable", "The embedding provider is temporarily unavailable.", true);
      throw new EmbeddingError("request_failed", `Embedding request was rejected (HTTP ${res.status}${code ? `, ${code}` : ""}).`, false);
    }

    const parsed = responseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success || parsed.data.data.length !== input.length) {
      throw new EmbeddingError("bad_response", "Unexpected response from the embedding provider.", false);
    }
    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (ordered.some((v) => v.length !== EMBEDDING_DIMENSIONS || v.some((x) => !Number.isFinite(x)))) {
      throw new EmbeddingError(
        "bad_response",
        `The embedding model returned vectors that aren't ${EMBEDDING_DIMENSIONS}-dimensional. Check EMBEDDING_MODEL.`,
        false,
      );
    }
    return ordered;
  }
}
