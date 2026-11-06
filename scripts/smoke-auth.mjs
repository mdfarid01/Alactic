// End-to-end smoke test of SIWE sign-in over real HTTP against a running app.
// Usage: APP_URL=http://localhost:3000 node scripts/smoke-auth.mjs
// Uses a throwaway, randomly generated wallet. Sends no blockchain transactions.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const APP = new URL(process.env.APP_URL ?? "http://localhost:3000");
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
};

class Jar {
  cookies = new Map();
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function req(jar, path, init = {}) {
  const res = await fetch(new URL(path, APP), {
    redirect: "manual",
    ...init,
    headers: { origin: APP.origin, cookie: jar.header(), ...(init.headers ?? {}) },
  });
  jar.store(res);
  return res;
}

async function signIn(account, jar = new Jar(), overrides = {}) {
  const nonceRes = await req(jar, "/api/auth/nonce", { method: "POST" });
  const { nonce } = await nonceRes.json();
  const now = new Date();
  const message = createSiweMessage({
    domain: APP.host,
    uri: APP.origin,
    address: account.address,
    chainId: 1,
    nonce,
    version: "1",
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 5 * 60_000),
    ...overrides,
  });
  const signature = await account.signMessage({ message });
  const res = await req(jar, "/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  return { res, jar, message, signature };
}

const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());

// 1. CSRF: cross-origin nonce request is refused.
{
  const res = await fetch(new URL("/api/auth/nonce", APP), { method: "POST", headers: { origin: "https://evil.example" } });
  check("nonce endpoint rejects foreign Origin", res.status === 403, `status ${res.status}`);
}

// 2. Valid sign-in.
const a = await signIn(alice);
check("valid SIWE sign-in succeeds", a.res.status === 200, `status ${a.res.status}`);
check("session cookie is set", [...a.jar.cookies.keys()].some((k) => k.endsWith("alactic_session")));

// 3. Replay of the same signed message fails.
{
  const res = await req(a.jar, "/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: a.message, signature: a.signature }),
  });
  check("replayed message is rejected", res.status === 401 || res.status === 400, `status ${res.status}`);
}

// 4. Wrong domain is rejected.
{
  const { res } = await signIn(mallory, new Jar(), { domain: "evil.example" });
  const body = await res.json();
  check("message for another domain is rejected", res.status === 401 && body.error.code === "domain_mismatch", body.error?.code);
}

// 5. Dashboard renders for Alice.
{
  const res = await req(a.jar, "/dashboard");
  const html = await res.text();
  check("dashboard renders with session", res.status === 200 && html.includes("Organizations"), `status ${res.status}`);
}

// 6. Alice creates an org through the UI's Server Action is hard to call from a script; use the DB-backed page check instead:
//    Mallory signs in and must get 404 for Alice's org once it exists (seeded below via SQL by the caller if desired).
const m = await signIn(mallory);
check("second wallet signs in", m.res.status === 200);

// 6b. Optional cross-tenant check: SMOKE_FOREIGN_ORG = slug of an org Mallory is NOT a member of.
if (process.env.SMOKE_FOREIGN_ORG) {
  const res = await req(m.jar, `/dashboard/${process.env.SMOKE_FOREIGN_ORG}`);
  const html = await res.text();
  check("non-member cannot see another org's dashboard", res.status === 404 || html.includes("NEXT_HTTP_ERROR_FALLBACK;404"), `status ${res.status}`);
}
if (process.env.SMOKE_ALICE_KEY_OUT) console.log("ALICE_ADDRESS", alice.address);

// 7. Logout revokes the session server-side: the old cookie no longer works.
{
  const stolen = new Jar();
  stolen.cookies = new Map(a.jar.cookies);
  const out = await req(a.jar, "/api/auth/logout", { method: "POST" });
  check("logout succeeds", out.status === 200);
  const res = await req(stolen, "/dashboard");
  const location = res.headers.get("location") ?? "";
  const html = res.status === 200 ? await res.text() : "";
  // The cookie still exists in the copied jar, so proxy lets it through; the page itself must not render user data.
  check(
    "revoked session cookie no longer grants access",
    location.includes("/sign-in") ||
      (html.includes("NEXT_REDIRECT") && !html.includes("Signed in as") && !html.includes("New organization")),
    `status ${res.status}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
