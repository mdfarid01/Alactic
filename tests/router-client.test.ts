import { describe, expect, it, vi } from "vitest";
import { RouterChatClient, stripReasoning, verificationStatusFrom, type ChatRequest } from "@/server/inference/router-client";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const req = (trustMode: ChatRequest["trustMode"] = "private", model = "0gm-1.0-35b-a3b", disableThinking = true): ChatRequest => ({
  disableThinking,
  model,
  trustMode,
  temperature: 0.3,
  maxTokens: 512,
  messages: [{ role: "user", content: "hi" }],
});

const okBody = (tee?: boolean | null) => ({
  id: "chatcmpl-1",
  choices: [{ message: { role: "assistant", content: " Hello! " } }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
  x_0g_trace: {
    request_id: "0852f405",
    provider: "0xd996",
    billing: { input_cost: "19000000000000", output_cost: "1916800000000000", total_cost: "1935800000000000" },
    ...(tee === undefined ? {} : { tee_verified: tee }),
  },
});

function client(fetchImpl: unknown, opts: { noKey?: boolean } = {}) {
  return new RouterChatClient({ baseUrl: "https://router.test/v1", apiKey: opts.noKey ? undefined : "sk-test", fetchImpl: fetchImpl as typeof fetch });
}

describe("0G Router chat client", () => {
  it("sends the trust mode header + verify_tee, parses the trace and uses ZG-Res-Key as chatID", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      void init;
      return json(okBody(true), 200, { "ZG-Res-Key": "zg-chat-77" });
    });
    const r = await client(fetchImpl).complete(req("private"));
    const init = fetchImpl.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["x-0g-provider-trust-mode"]).toBe("private");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "0gm-1.0-35b-a3b", verify_tee: true, stream: false, max_tokens: 512, chat_template_kwargs: { enable_thinking: false } });
    expect(r).toMatchObject({
      content: "Hello!",
      chatId: "zg-chat-77",
      inputTokens: 12,
      outputTokens: 3,
      verifyTeeRequested: true,
      trace: { requestId: "0852f405", provider: "0xd996", cost: { amount: "1935800000000000", unit: "neuron" }, teeVerified: true },
    });
  });

  it("standard mode still pins the trust header but doesn't request TEE verification", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      void init;
      return json(okBody());
    });
    const r = await client(fetchImpl).complete(req("standard", "qwen3.8-flash", false));
    const init = fetchImpl.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["x-0g-provider-trust-mode"]).toBe("standard");
    const body = JSON.parse(init.body as string);
    expect(body.verify_tee).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(r.chatId).toBe("chatcmpl-1"); // falls back to body id without ZG-Res-Key
    expect(r.trace.teeVerified).toBeNull();
  });

  it("no provider for the trust mode → typed error, exactly one request, never a lower tier", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { message: "no provider available for trust mode: tier=private", type: "server_error", code: "no_provider_for_trust_mode" }, request_id: "r9" }, 503),
    );
    await expect(client(fetchImpl).complete(req("private"))).rejects.toMatchObject({
      code: "no_provider_for_trust_mode",
      details: { httpStatus: 503, requestId: "r9" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 502 provider_error exactly once with the same trust mode", async () => {
    const responses = [json({ error: { code: "provider_error" } }, 502), json(okBody(true))];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      void init;
      return responses.shift()!;
    });
    await client(fetchImpl).complete(req("private"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect((call[1]!.headers as Record<string, string>)["x-0g-provider-trust-mode"]).toBe("private");
  });

  it.each([
    [401, "auth"],
    [402, "insufficient_balance"],
    [429, "rate_limited"],
    [400, "bad_request"],
  ])("HTTP %s → %s (no retry)", async (status, code) => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "x" } }, status));
    await expect(client(fetchImpl).complete(req())).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires an API key and never calls the network without one", async () => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl, { noKey: true }).complete(req())).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses the live billing shape (USD micro-units)", async () => {
    const live = { ...okBody(), x_0g_trace: { billing: { currency: "usd", input_cost: "4", output_cost: "16", total_cost: "20", total_cost_usd_micro: "20" }, provider: "0xf4FB", request_id: "49ec" } };
    const r = await client(vi.fn(async () => json(live))).complete(req());
    expect(r.trace.cost).toEqual({ amount: "20", unit: "usd_micro" });
    expect(r.trace.teeVerified).toBeNull(); // observed live: tee_verified absent even with verify_tee
  });

  it("strips leaked reasoning (observed live on glm-5.3)", () => {
    expect(stripReasoning("The user asks X. I should be concise.</think>A refund policy is…")).toBe("A refund policy is…");
    expect(stripReasoning("<think>hidden</think>\nAnswer")).toBe("Answer");
    expect(stripReasoning("Plain answer")).toBe("Plain answer");
  });

  it.each([
    [429, "model_overloaded", "model_overloaded"],
    [403, "trust_mode_mismatch", "trust_mode_mismatch"],
  ])("HTTP %s %s (seen live) maps to %s", async (status, routerCode, code) => {
    const fetchImpl = vi.fn(async () => json({ error: { code: routerCode, type: "x" } }, status, { "retry-after": "30" }));
    await expect(client(fetchImpl).complete(req())).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps tee_verified to verification status exactly", () => {
    expect(verificationStatusFrom(false, null)).toBe("not_requested");
    expect(verificationStatusFrom(true, true)).toBe("verified");
    expect(verificationStatusFrom(true, false)).toBe("failed");
    expect(verificationStatusFrom(true, null)).toBe("unavailable");
  });
});
