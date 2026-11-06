import { describe, expect, it, vi } from "vitest";
import { ZeroGEmbeddingProvider } from "@/server/knowledge/embeddings";
import { FirecrawlCrawler } from "@/server/knowledge/firecrawl";

const vec = (seed: number) => Array.from({ length: 1024 }, (_, i) => ((i + seed) % 7) / 7);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function provider(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof ZeroGEmbeddingProvider>[0]> = {}) {
  return new ZeroGEmbeddingProvider({
    baseUrl: "https://router.test/v1",
    apiKey: "sk-test",
    model: "qwen3-embedding-0.6b",
    trustMode: "private",
    sendDimensions: false,
    fetchImpl,
    ...overrides,
  });
}

describe("0G embedding provider", () => {
  it("always sends the trust mode header and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return json({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] });
    });
    const result = await provider(fetchImpl as unknown as typeof fetch).embedDocuments(["a", "b"]);
    expect(result[0]).toEqual(vec(1));
    const init = fetchImpl.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["x-0g-provider-trust-mode"]).toBe("private");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "qwen3-embedding-0.6b", input: ["a", "b"] });
    expect(JSON.parse(init.body as string).dimensions).toBeUndefined();
  });

  it("prefixes queries with the Qwen3 instruction, but not documents", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return json({ data: [{ index: 0, embedding: vec(0) }] });
    }) as unknown as typeof fetch;
    const p = provider(fetchImpl);
    await p.embedQuery("refund?");
    await p.embedDocuments(["doc"]);
    expect(JSON.parse(bodies[0]).input[0]).toMatch(/^Instruct: .+\nQuery: refund\?$/);
    expect(JSON.parse(bodies[1]).input[0]).toBe("doc");
  });

  it("fails clearly without an API key (no network call)", async () => {
    const fetchImpl = vi.fn();
    await expect(provider(fetchImpl as unknown as typeof fetch, { apiKey: undefined }).embedQuery("x")).rejects.toMatchObject({
      code: "not_configured",
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces 'no provider for trust mode' as retryable, and never retries in another mode", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "no_provider_for_trust_mode", message: "no provider available for trust mode: tier=private" } }, 503),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).embedDocuments(["a"])).rejects.toMatchObject({
      code: "no_provider_for_trust_mode",
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "auth", false],
    [402, "insufficient_balance", false],
    [429, "rate_limited", true],
    [502, "provider_unavailable", true],
  ])("maps HTTP %s to %s", async (status, code, retryable) => {
    const fetchImpl = (async () => json({ error: { code: "x" } }, status, { "retry-after": "7" })) as unknown as typeof fetch;
    await expect(provider(fetchImpl).embedDocuments(["a"])).rejects.toMatchObject({ code, retryable });
  });

  it("rejects vectors with the wrong dimension", async () => {
    const fetchImpl = (async () => json({ data: [{ index: 0, embedding: [0.1, 0.2] }] })) as unknown as typeof fetch;
    await expect(provider(fetchImpl).embedDocuments(["a"])).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("Firecrawl v2 client", () => {
  it("starts a same-site crawl with markdown output", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      void init;
      return json({ success: true, id: "crawl-123", url: "https://api.firecrawl.dev/v2/crawl/crawl-123" });
    });
    const id = await new FirecrawlCrawler("fc-key", "https://fc.test/v2", fetchImpl as unknown as typeof fetch).start("https://acme.com", { maxPages: 20 });
    expect(id).toBe("crawl-123");
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ url: "https://acme.com", limit: 20, allowExternalLinks: false, allowSubdomains: false, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } });
  });

  it("reports progress while scraping, then follows pagination and skips failed pages", async () => {
    const responses = [
      json({ status: "scraping", total: 3, completed: 1, data: [] }),
      json({
        status: "completed",
        next: "https://fc.test/v2/crawl/c1?skip=2",
        data: [
          { markdown: "# A", metadata: { title: "A", url: "https://acme.com/a", statusCode: 200 } },
          { markdown: "Not found", metadata: { url: "https://acme.com/x", statusCode: 404 } },
        ],
      }),
      json({ status: "completed", next: null, data: [{ markdown: "# B", metadata: { title: ["B"], sourceURL: "https://acme.com/b" } }] }),
    ];
    const fetchImpl = (async () => responses.shift()!) as unknown as typeof fetch;
    const crawler = new FirecrawlCrawler("fc-key", "https://fc.test/v2", fetchImpl);
    expect(await crawler.check("c1")).toEqual({ state: "running", completed: 1, total: 3 });
    expect(await crawler.check("c1")).toEqual({
      state: "completed",
      pages: [
        { url: "https://acme.com/a", title: "A", markdown: "# A" },
        { url: "https://acme.com/b", title: "B", markdown: "# B" },
      ],
    });
  });

  it("fails clearly without an API key", async () => {
    await expect(new FirecrawlCrawler(undefined).start("https://acme.com", { maxPages: 1 })).rejects.toThrow(/Firecrawl API key/);
  });
});
