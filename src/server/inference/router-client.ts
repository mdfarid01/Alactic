import { z } from "zod";
import type { TrustModeOption } from "@/lib/agent-options";

/** OpenAI-style content part. Images are sent inline as data: URIs (docs: router/features/image-inputs). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  trustMode: TrustModeOption;
  temperature: number;
  maxTokens: number;
  /** Send chat_template_kwargs.enable_thinking=false (only for models whose catalog lists chat_template_kwargs). */
  disableThinking?: boolean;
};

export type RouterTrace = {
  requestId: string | null;
  provider: string | null;
  /** Total cost as reported by x_0g_trace.billing. Live (2026-11-06): USD micro-units; docs: neuron. */
  cost: { amount: string; unit: "usd_micro" | "neuron" | "unknown" } | null;
  /** Raw tee_verified value: true / false / null (absent or null). */
  teeVerified: boolean | null;
};

export type ChatResult = {
  content: string;
  /** chatID for independent verification: ZG-Res-Key header, else body id. */
  chatId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  trace: RouterTrace;
  verifyTeeRequested: boolean;
  latencyMs: number;
};

export type InferenceErrorCode =
  | "not_configured"
  | "bad_request"
  | "auth"
  | "insufficient_balance"
  | "rate_limited"
  | "model_overloaded"
  | "trust_mode_mismatch"
  | "no_provider_for_trust_mode"
  | "no_available_provider"
  | "provider_error"
  | "timeout"
  | "bad_response"
  | "network";

export class InferenceError extends Error {
  constructor(
    public readonly code: InferenceErrorCode,
    message: string,
    public readonly details: { httpStatus?: number; routerCode?: string; routerType?: string; requestId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
  }
}

export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResult>;
}

export type TranscribeRequest = { model: string; trustMode: TrustModeOption; audio: Uint8Array; mime: string; filename: string };
export type TranscribeResult = { text: string; chatId: string | null; trace: RouterTrace; verifyTeeRequested: boolean; latencyMs: number; durationSeconds: number | null };

export interface Transcriber {
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}



const traceSchema = z
  .object({
    request_id: z.string().nullish(),
    provider: z.string().nullish(),
    billing: z
      .object({
        currency: z.string().nullish(),
        total_cost: z.union([z.string(), z.number()]).nullish(),
        total_cost_usd_micro: z.union([z.string(), z.number()]).nullish(),
      })
      .partial()
      .nullish(),
    tee_verified: z.boolean().nullish(),
  })
  .passthrough();

const transcriptionSchema = z.object({
  text: z.string(),
  usage: z.object({ seconds: z.number().nullish() }).partial().nullish(),
  x_0g_trace: traceSchema.nullish(),
});

const responseSchema = z.object({
  id: z.string().nullish(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).passthrough() }).passthrough())
    .min(1),
  usage: z.object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() }).partial().nullish(),
  x_0g_trace: traceSchema.nullish(),
});

const errorSchema = z.object({
  error: z.object({ message: z.string().nullish(), type: z.string().nullish(), code: z.string().nullish() }).partial(),
  request_id: z.string().nullish(),
});

export type RouterClientConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * 0G Compute Router chat client (OpenAI-compatible, non-streaming).
 * - Always sends X-0G-Provider-Trust-Mode, so unpinned routing to `standard` providers can't happen.
 * - Requests TEE verification (verify_tee) for private/verified modes.
 * - Never retries in a different trust mode. The only retry is one attempt after a 502 provider_error, same request.
 * Non-streaming because x_0g_trace (verification evidence) is only documented on non-streaming responses.
 */
export class RouterChatClient implements ChatClient, Transcriber {
  constructor(private readonly config: RouterClientConfig) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    if (!this.config.apiKey) {
      throw new InferenceError("not_configured", "AI inference isn't configured on this server yet (0G Router API key missing).");
    }
    try {
      return await this.once(request);
    } catch (error) {
      if (error instanceof InferenceError && error.code === "provider_error") return this.once(request);
      throw error;
    }
  }

  /**
   * Speech-to-text (POST /v1/audio/transcriptions, multipart). Same guarantees as chat: explicit trust-mode header,
   * verify_tee as a query parameter for private/verified (docs: router/features/audio), no retry in another mode.
   */
  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.config.apiKey) {
      throw new InferenceError("not_configured", "AI inference isn't configured on this server yet (0G Router API key missing).");
    }
    const verifyTee = request.trustMode !== "standard";
    const form = new FormData();
    form.set("file", new Blob([request.audio as BlobPart], { type: request.mime }), request.filename);
    form.set("model", request.model);
    form.set("response_format", "json");
    const started = Date.now();
    let res: Response;
    try {
      res = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl}/audio/transcriptions${verifyTee ? "?verify_tee=true" : ""}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
        headers: { authorization: `Bearer ${this.config.apiKey}`, "x-0g-provider-trust-mode": request.trustMode },
        body: form,
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new InferenceError(timedOut ? "timeout" : "network", timedOut ? "Transcription took too long." : "Couldn't reach the 0G Router.");
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) throw await toError(res, { model: request.model, trustMode: request.trustMode });
    const json = transcriptionSchema.safeParse(await res.json().catch(() => null));
    if (!json.success) throw new InferenceError("bad_response", "Unexpected transcription response from the 0G Router.", { httpStatus: res.status });
    const trace = json.data.x_0g_trace;
    return {
      text: json.data.text.trim(),
      chatId: res.headers.get("zg-res-key"),
      trace: { requestId: trace?.request_id ?? null, provider: trace?.provider ?? null, cost: parseCost(trace?.billing ?? null), teeVerified: trace?.tee_verified ?? null },
      verifyTeeRequested: verifyTee,
      latencyMs,
      durationSeconds: json.data.usage?.seconds ?? null,
    };
  }

  private async once(request: ChatRequest): Promise<ChatResult> {
    const verifyTee = request.trustMode !== "standard";
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
      ...(verifyTee ? { verify_tee: true } : {}),
      // Thinking models (glm-*, 0gm-*) otherwise spend the token budget on hidden reasoning (observed live).
      ...(request.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
    const started = Date.now();
    let res: Response;
    try {
      res = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "x-0g-provider-trust-mode": request.trustMode,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new InferenceError(timedOut ? "timeout" : "network", timedOut ? "The AI provider took too long to respond." : "Couldn't reach the 0G Router.");
    }
    const latencyMs = Date.now() - started;

    if (!res.ok) throw await toError(res, request);

    const json = responseSchema.safeParse(await res.json().catch(() => null));
    if (!json.success) throw new InferenceError("bad_response", "Unexpected response from the 0G Router.", { httpStatus: res.status });
    const trace = json.data.x_0g_trace;
    return {
      content: stripReasoning(json.data.choices[0].message.content ?? ""),
      chatId: res.headers.get("zg-res-key") ?? json.data.id ?? null,
      inputTokens: json.data.usage?.prompt_tokens ?? null,
      outputTokens: json.data.usage?.completion_tokens ?? null,
      trace: {
        requestId: trace?.request_id ?? null,
        provider: trace?.provider ?? null,
        cost: parseCost(trace?.billing ?? null),
        teeVerified: trace?.tee_verified ?? null,
      },
      verifyTeeRequested: verifyTee,
      latencyMs,
    };
  }
}

async function toError(res: Response, request: Pick<ChatRequest, "model" | "trustMode">): Promise<InferenceError> {
  const parsed = errorSchema.safeParse(await res.json().catch(() => null));
  const routerCode = parsed.success ? (parsed.data.error.code ?? undefined) : undefined;
  const routerType = parsed.success ? (parsed.data.error.type ?? undefined) : undefined;
  const requestId = parsed.success ? (parsed.data.request_id ?? undefined) : undefined;
  const details = { httpStatus: res.status, routerCode, routerType, requestId, retryAfterSeconds: Number(res.headers.get("retry-after")) || undefined };
  switch (true) {
    case res.status === 403 && routerCode === "trust_mode_mismatch":
      return new InferenceError(
        "trust_mode_mismatch",
        `This server's 0G API key is restricted to a different trust mode than this agent's (${request.trustMode}). Choose a matching trust mode or use a matching key.`,
        details,
      );
    case res.status === 401 || res.status === 403:
      return new InferenceError("auth", "The 0G Router rejected this server's API key.", details);
    case res.status === 402:
      return new InferenceError("insufficient_balance", "The platform's 0G balance is too low to run AI responses.", details);
    case res.status === 429 && routerCode === "model_overloaded":
      return new InferenceError("model_overloaded", `${request.model} is temporarily overloaded on 0G. Try again in a moment.`, details);
    case res.status === 429:
      return new InferenceError("rate_limited", "The AI provider is rate limiting requests. Try again shortly.", details);
    case res.status === 503 && routerCode === "no_provider_for_trust_mode":
      return new InferenceError(
        "no_provider_for_trust_mode",
        `No ${request.trustMode} provider is available for ${request.model} right now. The agent did not fall back to a less private mode.`,
        details,
      );
    case res.status === 503:
      return new InferenceError("no_available_provider", `No healthy provider is available for ${request.model} right now.`, details);
    case res.status === 502:
      return new InferenceError("provider_error", "The AI provider returned an error.", details);
    case res.status === 400:
      return new InferenceError("bad_request", "The AI request was rejected as invalid.", details);
    default:
      return new InferenceError("provider_error", `The AI request failed (HTTP ${res.status}).`, details);
  }
}

/** Map the raw tee_verified value to our verification status. */
export function verificationStatusFrom(verifyTeeRequested: boolean, teeVerified: boolean | null) {
  if (!verifyTeeRequested) return "not_requested" as const;
  if (teeVerified === true) return "verified" as const;
  if (teeVerified === false) return "failed" as const;
  return "unavailable" as const;
}

/** Remove leaked reasoning: `<think>…</think>` blocks, or everything up to a stray closing `</think>` (seen live on glm-5.3). */
export function stripReasoning(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close >= 0) out = out.slice(close + "</think>".length);
  return out.trim();
}

function parseCost(billing: { currency?: string | null; total_cost?: string | number | null; total_cost_usd_micro?: string | number | null } | null) {
  if (!billing) return null;
  if (billing.total_cost_usd_micro !== undefined && billing.total_cost_usd_micro !== null) {
    return { amount: String(billing.total_cost_usd_micro), unit: "usd_micro" as const };
  }
  if (billing.total_cost === undefined || billing.total_cost === null) return null;
  const unit = !billing.currency ? ("neuron" as const) : billing.currency.toLowerCase() === "usd" ? ("unknown" as const) : ("unknown" as const);
  return { amount: String(billing.total_cost), unit };
}
