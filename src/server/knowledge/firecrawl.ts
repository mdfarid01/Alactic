import { z } from "zod";

/** A crawled page, already reduced to what we store. */
export type CrawledPage = { url: string; title: string; markdown: string };

export type CrawlJobState =
  | { state: "running"; completed: number; total: number }
  | { state: "completed"; pages: CrawledPage[] }
  | { state: "failed"; error: string };

export interface Crawler {
  start(url: string, options: { maxPages: number; includePaths?: string[]; excludePaths?: string[] }): Promise<string>;
  check(jobId: string): Promise<CrawlJobState>;
}

export class CrawlerError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

// Firecrawl v2 API (verified against docs.firecrawl.dev on 2026-11-06): POST /v2/crawl, GET /v2/crawl/{id}.
const startSchema = z.object({ success: z.boolean().optional(), id: z.string().min(1) });
const pageSchema = z.object({
  markdown: z.string().optional().nullable(),
  metadata: z
    .object({
      title: z.union([z.string(), z.array(z.string())]).optional().nullable(),
      sourceURL: z.string().optional().nullable(),
      url: z.string().optional().nullable(),
      statusCode: z.number().optional().nullable(),
      error: z.string().optional().nullable(),
    })
    .passthrough()
    .optional(),
});
const statusSchema = z.object({
  status: z.string(),
  total: z.number().optional(),
  completed: z.number().optional(),
  next: z.string().nullable().optional(),
  data: z.array(z.unknown()).optional(),
});

export class FirecrawlCrawler implements Crawler {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl = "https://api.firecrawl.dev/v2",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers() {
    if (!this.apiKey) throw new CrawlerError("Website crawling isn't configured yet (missing Firecrawl API key).", false);
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
  }

  async start(url: string, options: { maxPages: number; includePaths?: string[]; excludePaths?: string[] }) {
    const res = await this.fetchImpl(`${this.baseUrl}/crawl`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        url,
        limit: options.maxPages,
        sitemap: "include",
        crawlEntireDomain: false,
        allowSubdomains: false,
        allowExternalLinks: false,
        ignoreQueryParameters: true,
        ...(options.includePaths?.length ? { includePaths: options.includePaths } : {}),
        ...(options.excludePaths?.length ? { excludePaths: options.excludePaths } : {}),
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    }).catch(() => {
      throw new CrawlerError("Couldn't reach the crawling service.", true);
    });
    if (!res.ok) throw new CrawlerError(`The crawling service rejected the request (HTTP ${res.status}).`, res.status >= 500 || res.status === 429);
    const parsed = startSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new CrawlerError("Unexpected response from the crawling service.", false);
    return parsed.data.id;
  }

  /**
   * Scrape one page (POST /v2/scrape, formats ["markdown"]; response `data.markdown`, checked live 2026-11-07).
   * Used to draft gap answers from a single page of the business's own site.
   */
  async scrape(url: string): Promise<CrawledPage> {
    const res = await this.fetchImpl(`${this.baseUrl}/scrape`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    }).catch(() => {
      throw new CrawlerError("Couldn't reach the crawling service.", true);
    });
    if (!res.ok) throw new CrawlerError(`The page couldn't be fetched (HTTP ${res.status}).`, res.status >= 500 || res.status === 429);
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown } | null;
    const page = pageSchema.safeParse(body?.data);
    if (!body?.success || !page.success || !page.data.markdown) throw new CrawlerError("The page had no readable content.", false);
    const meta = page.data.metadata;
    if (meta?.statusCode && meta.statusCode >= 400) throw new CrawlerError(`The page returned HTTP ${meta.statusCode}.`, false);
    const title = Array.isArray(meta?.title) ? meta.title[0] : meta?.title;
    return { url: meta?.url ?? meta?.sourceURL ?? url, title: (title || url).slice(0, 200), markdown: page.data.markdown };
  }

  async check(jobId: string): Promise<CrawlJobState> {
    const pages: CrawledPage[] = [];
    let url: string | null = `${this.baseUrl}/crawl/${encodeURIComponent(jobId)}`;
    let first = true;
    // Follow `next` pagination (each chunk ≤ 10MB) once the crawl is complete.
    for (let guard = 0; url && guard < 50; guard++) {
      const res: Response = await this.fetchImpl(url, { headers: this.headers(), signal: AbortSignal.timeout(30_000) }).catch(() => {
        throw new CrawlerError("Couldn't reach the crawling service.", true);
      });
      if (!res.ok) throw new CrawlerError(`Crawl status check failed (HTTP ${res.status}).`, res.status >= 500 || res.status === 429);
      const body = statusSchema.safeParse(await res.json().catch(() => null));
      if (!body.success) throw new CrawlerError("Unexpected response from the crawling service.", false);
      const { status } = body.data;
      if (first && status === "scraping") return { state: "running", completed: body.data.completed ?? 0, total: body.data.total ?? 0 };
      if (status === "failed" || status === "cancelled") return { state: "failed", error: `The crawl ${status}.` };
      first = false;
      for (const raw of body.data.data ?? []) {
        const page = pageSchema.safeParse(raw);
        if (!page.success || !page.data.markdown) continue;
        const meta = page.data.metadata;
        if (meta?.error || (meta?.statusCode && meta.statusCode >= 400)) continue;
        const pageUrl = meta?.url ?? meta?.sourceURL;
        if (!pageUrl) continue;
        const title = Array.isArray(meta?.title) ? meta.title[0] : meta?.title;
        pages.push({ url: pageUrl, title: (title || pageUrl).slice(0, 200), markdown: page.data.markdown });
      }
      url = body.data.next ?? null;
    }
    return { state: "completed", pages };
  }
}
