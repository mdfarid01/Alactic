import { describe, expect, it } from "vitest";
import { parseChatModels, parseTrustAvailability, trustModesFor, validateModelChoice } from "@/server/inference/catalog-parse";

// Shapes taken from live GET /v1/models and /v1/providers responses (2026-11-06), trimmed.
const modelsFixture = {
  object: "list",
  data: [
    { id: "qwen3.8-flash", type: "chatbot", provider_count: 1, context_length: 1000000, verifiability: null, supported_parameters: ["tools"], pricing_usd: { prompt: "0.0000002", completion: "0.0000006" } },
    { id: "glm-5.3", name: "GLM-5.3", type: "chatbot", provider_count: 3, context_length: 1179648, verifiability: "TeeML", supported_parameters: ["tools", "stream"], pricing_usd: { prompt: "0.0000014", completion: "0.0000044" } },
    { id: "qwen3-embedding-8b", type: "embedding", provider_count: 1, verifiability: "TeeML" },
    { id: "tls-model", type: "chatbot", provider_count: 1, verifiability: "TeeTLS" },
    { id: "dead-model", type: "chatbot", provider_count: 0 },
    { id: 42, type: "chatbot" },
    { id: "weird", type: "chatbot", provider_count: 1, verifiability: "SomethingNew" },
  ],
};

describe("0G catalog parsing", () => {
  it("keeps only usable chat models, TEE models first, and maps trust capabilities", () => {
    const models = parseChatModels(modelsFixture);
    expect(models.map((m) => m.id)).toEqual(["glm-5.3", "tls-model", "qwen3.8-flash", "weird"]);
    expect(models[0]).toMatchObject({ verifiability: "TeeML", trustModes: ["private", "verified", "standard"], supportsTools: true });
    expect(models[1].trustModes).toEqual(["verified", "standard"]);
    expect(models.find((m) => m.id === "weird")?.trustModes).toEqual(["standard"]); // unknown verifiability ⇒ not trusted
  });

  it("rejects a payload that isn't a list", () => {
    expect(() => parseChatModels({ nope: true })).toThrow();
  });

  it("private availability requires a healthy provider that reports trust_mode=private", () => {
    // glm-5.3 on 2026-11-06: one TeeML provider + two standard channels.
    const providers = {
      data: [
        { address: "0xD179", trust_mode: "private", verifiability: "TeeML", is_healthy: false },
        { address: "0x0000", trust_mode: "standard", is_healthy: true },
        { address: "0x0000", trust_mode: "standard", is_healthy: true },
      ],
    };
    expect(parseTrustAvailability(providers)).toEqual({ private: false, verified: false, standard: true });
    providers.data[0].is_healthy = true;
    expect(parseTrustAvailability(providers)).toEqual({ private: true, verified: true, standard: true });
  });

  it("treats unknown health as unhealthy", () => {
    expect(parseTrustAvailability({ data: [{ trust_mode: "private", is_healthy: null }] })).toEqual({
      private: false,
      verified: false,
      standard: false,
    });
  });

  it("validates model + trust combinations", () => {
    const models = parseChatModels(modelsFixture);
    expect(validateModelChoice(models, "glm-5.3", "private")).toBeNull();
    expect(validateModelChoice(models, "qwen3.8-flash", "private")).toMatch(/can't run in private/);
    expect(validateModelChoice(models, "tls-model", "private")).toMatch(/can't run in private/);
    expect(validateModelChoice(models, "tls-model", "verified")).toBeNull();
    expect(validateModelChoice(models, "qwen3-embedding-8b", "private")).toMatch(/isn't available/);
    expect(trustModesFor(null)).toEqual(["standard"]);
  });
});
