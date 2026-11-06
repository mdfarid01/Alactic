import { db } from "@/server/db/client";
import { getPublicAgent } from "@/server/public/service";
import { getTrustStats, pct } from "@/server/public/trust";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Shields-style SVG: "Alactic verified AI | 97% TEE-verified". Text is escaped; no external resources. */
function badge(label: string, message: string, color: string) {
  const w = (t: string) => Math.round(t.length * 6.6 + 12);
  const lw = w(label);
  const mw = w(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + mw}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">
<title>${esc(label)}: ${esc(message)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + mw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#24292f"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${lw + mw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}

/** Live trust badge for a published agent (embeddable on any website, cached for 5 minutes). */
export async function GET(_request: Request, ctx: RouteContext<"/a/[slug]/badge.svg">) {
  const { slug } = await ctx.params;
  const agent = await getPublicAgent(db(), slug);
  const headers = {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  };
  if (!agent) return new Response(badge("Alactic", "not available", "#6e7781"), { status: 404, headers });
  const s = await getTrustStats(db(), agent);
  const p = pct(s.verified, s.answers);
  const message = p == null ? (agent.trustMode === "private" ? "private TEE AI" : `${agent.trustMode} AI`) : `${p}% TEE-verified`;
  const color = p == null ? "#0969da" : p >= 90 ? "#1a7f37" : p >= 60 ? "#9a6700" : "#cf222e";
  return new Response(badge("Alactic verified AI", message, color), { headers });
}
