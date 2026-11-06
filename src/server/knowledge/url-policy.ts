import { isIP } from "node:net";

/**
 * Validate a website URL submitted for crawling.
 * Crawling is performed by Firecrawl (not from our network), but we still refuse URLs that point at private or
 * special-purpose hosts, carry credentials, or use non-web ports. If we ever fetch URLs ourselves, DNS results must
 * be re-checked against these ranges after resolution and after every redirect.
 */
export function validateCrawlUrl(input: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Enter a full URL, e.g. https://example.com/help" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Only http and https URLs are supported" };
  if (url.username || url.password) return { ok: false, error: "URLs with credentials aren't allowed" };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "Only standard web ports are allowed" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return { ok: false, error: "Use a domain name, not an IP address" };
  if (
    host === "localhost" ||
    !host.includes(".") ||
    /\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host) ||
    host === "metadata.google.internal"
  ) {
    return { ok: false, error: "That host isn't publicly reachable" };
  }
  url.hash = "";
  return { ok: true, url };
}
