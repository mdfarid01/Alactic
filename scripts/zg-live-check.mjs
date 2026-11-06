// Live checks against the real 0G Compute Router. Small requests only (a few cents at most).
// Usage: set -a; . ./.env.local; set +a; node scripts/zg-live-check.mjs
// Never prints the API key.
const BASE = (process.env.ZG_ROUTER_BASE_URL || "https://router-api.0g.ai/v1").replace(/\/+$/, "");
const KEY = process.env.ZG_ROUTER_API_KEY;
if (!KEY) { console.error("ZG_ROUTER_API_KEY is not set"); process.exit(1); }

const headersOf = (res) => Object.fromEntries([...res.headers].filter(([k]) => /^(zg-|x-ratelimit|retry-after)/i.test(k)));

async function chat(label, model, trust, { stream = false } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-0g-provider-trust-mode": trust },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: "You are a concise support assistant." }, { role: "user", content: "In one sentence: what is a refund policy?" }],
      max_tokens: 80,
      temperature: 0.2,
      stream,
      verify_tee: trust !== "standard",
      // Both glm-* and 0gm-* are thinking models; without this, small max_tokens budgets go entirely to reasoning.
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const ms = Date.now() - t0;
  console.log(`\n=== ${label} — HTTP ${res.status} in ${ms} ms`);
  console.log("headers:", JSON.stringify(headersOf(res)));
  if (!stream) {
    const body = await res.json().catch(() => null);
    if (!res.ok) return console.log("error:", JSON.stringify(body));
    console.log("id:", body.id, "| model:", body.model);
    console.log("content:", JSON.stringify(body.choices?.[0]?.message?.content?.slice(0, 160)));
    console.log("message keys:", Object.keys(body.choices?.[0]?.message ?? {}).join(","));
    console.log("usage:", JSON.stringify(body.usage));
    console.log("x_0g_trace:", JSON.stringify(body.x_0g_trace));
    console.log("top-level keys:", Object.keys(body).join(","));
    return;
  }
  if (!res.ok) return console.log("error:", await res.text());
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  const traces = lines.filter((l) => l.includes("x_0g_trace"));
  console.log("SSE data lines:", lines.length, "| lines containing x_0g_trace:", traces.length);
  console.log("last 2 data lines:", lines.slice(-2).map((l) => l.slice(0, 400)).join("\n"));
  if (traces.length) console.log("trace line:", traces.at(-1).slice(0, 600));
}

async function embed(label, model, trust, dims) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-0g-provider-trust-mode": trust },
    body: JSON.stringify({ model, input: ["Refunds are accepted within 45 days."], encoding_format: "float", ...(dims ? { dimensions: dims } : {}) }),
  });
  const body = await res.json().catch(() => null);
  console.log(`\n=== ${label} — HTTP ${res.status} in ${Date.now() - t0} ms`);
  if (!res.ok) return console.log("error:", JSON.stringify(body));
  console.log("vectors:", body.data?.length, "| dims:", body.data?.[0]?.embedding?.length, "| usage:", JSON.stringify(body.usage), "| x_0g_trace:", JSON.stringify(body.x_0g_trace));
}

const only = process.argv[2];
if (!only || only === "chat") {
  await chat("glm-5.3 · private · verify_tee", "glm-5.3", "private");
  await chat("0gm-1.0-35b-a3b · private · verify_tee", "0gm-1.0-35b-a3b", "private");
}
if (!only || only === "embed") {
  await embed("qwen3-embedding-0.6b · private", "qwen3-embedding-0.6b", "private");
  await embed("qwen3.7-text-embedding · verified · dims=1024", "qwen3.7-text-embedding", "verified", 1024);
}
if (!only || only === "stream") await chat("0gm · private · verify_tee · STREAM", "0gm-1.0-35b-a3b", "private", { stream: true });
