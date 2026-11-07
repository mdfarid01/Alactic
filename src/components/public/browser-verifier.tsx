"use client";

import { useState } from "react";
import { createPublicClient, defineChain, getAddress, http, isAddress, isAddressEqual, isHex, recoverMessageAddress, type Hex } from "viem";
import { CheckCircle2, Circle, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { CHAT_ID_RE, expectedSigner, getServiceAbi, signatureUrl, type ServiceRecord } from "@/lib/tee-shared";
import { cn } from "@/lib/utils";

type StepState = "idle" | "running" | "ok" | "fail";
type Step = { title: string; state: StepState; detail?: string };

const INITIAL: Step[] = [
  { title: "Read the provider's service record from 0G Chain", state: "idle" },
  { title: "Check the provider is TEE-verifiable and its signer is acknowledged on-chain", state: "idle" },
  { title: "Fetch the TEE signature for this chat from the provider", state: "idle" },
  { title: "Recover the signer from the signature, locally in your browser", state: "idle" },
  { title: "Compare it with the on-chain TEE signer", state: "idle" },
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Trustless check: this browser talks to 0G Chain and the provider directly. Alactic's servers are not involved,
 * so a visitor doesn't have to trust Alactic's own verification verdict.
 */
export function BrowserVerifier({ provider, chatId, chain }: { provider: string; chatId: string; chain: { rpcUrl: string; chainId: number; contract: string } }) {
  const [steps, setSteps] = useState<Step[]>(INITIAL);
  const [verdict, setVerdict] = useState<"idle" | "running" | "verified" | "failed">("idle");

  const run = async () => {
    setVerdict("running");
    const s = INITIAL.map((x) => ({ ...x }));
    const update = (i: number, state: StepState, detail?: string) => {
      s[i] = { ...s[i], state, detail };
      setSteps([...s]);
    };
    const fail = (i: number, detail: string) => {
      update(i, "fail", detail);
      setVerdict("failed");
    };
    setSteps(s);

    if (!isAddress(provider) || !CHAT_ID_RE.test(chatId)) return fail(0, "This receipt has no usable provider address or chat ID.");

    // 1. On-chain service record
    update(0, "running");
    let svc: ServiceRecord;
    try {
      const c = defineChain({ id: chain.chainId, name: "0G", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } });
      const client = createPublicClient({ chain: c, transport: http(chain.rpcUrl, { timeout: 10_000 }) });
      const r = await client.readContract({ address: chain.contract as Hex, abi: getServiceAbi, functionName: "getService", args: [getAddress(provider)] });
      svc = { url: r.url, model: r.model, verifiability: r.verifiability, teeSignerAddress: r.teeSignerAddress, teeSignerAcknowledged: r.teeSignerAcknowledged, additionalInfo: r.additionalInfo };
      update(0, "ok", `Contract ${short(chain.contract)} on chain ${chain.chainId}: model ${svc.model}, endpoint ${new URL(svc.url).host}`);
    } catch {
      return fail(0, `Couldn't read the service record from ${new URL(chain.rpcUrl).host}.`);
    }

    // 2. Verifiability + acknowledged signer
    update(1, "running");
    let signer: string;
    try {
      signer = expectedSigner(svc);
    } catch {
      return fail(1, "The provider's on-chain service info is malformed.");
    }
    if ((svc.verifiability !== "TeeML" && svc.verifiability !== "TeeTLS") || !svc.teeSignerAcknowledged || !isAddress(signer)) {
      return fail(1, `Verifiability "${svc.verifiability || "none"}", signer acknowledged: ${svc.teeSignerAcknowledged}.`);
    }
    update(1, "ok", `${svc.verifiability} · expected signer ${short(signer)}`);

    // 3. Signature from the provider
    update(2, "running");
    const url = signatureUrl(svc, chatId);
    if (!url.startsWith("https://")) return fail(2, "The provider's signature endpoint isn't https.");
    let payload: { text?: unknown; signature?: unknown } | null = null;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return fail(2, `The provider returned HTTP ${res.status}. Signatures may expire after a while.`);
      payload = (await res.json()) as { text?: unknown; signature?: unknown };
    } catch {
      return fail(2, "The provider's signature endpoint didn't respond (or blocked this browser).");
    }
    if (typeof payload?.text !== "string" || typeof payload.signature !== "string" || !isHex(payload.signature)) {
      return fail(2, "The provider returned no usable signature.");
    }
    update(2, "ok", `Signed text: ${payload.text.slice(0, 48)}${payload.text.length > 48 ? "…" : ""}`);

    // 4. Recover locally
    update(3, "running");
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: payload.text, signature: payload.signature as Hex });
    } catch {
      return fail(3, "The signature couldn't be decoded.");
    }
    update(3, "ok", `Recovered ${recovered}`);

    // 5. Compare
    update(4, "running");
    if (!isAddressEqual(recovered as Hex, signer as Hex)) return fail(4, `Recovered ${short(recovered)} ≠ on-chain signer ${short(signer)}.`);
    update(4, "ok", `${getAddress(signer)} ✓`);
    setVerdict("verified");
  };

  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5">
              {step.state === "ok" ? (
                <CheckCircle2 className="size-5 text-success" />
              ) : step.state === "fail" ? (
                <XCircle className="size-5 text-destructive" />
              ) : step.state === "running" ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : (
                <Circle className="size-5 text-muted-foreground/50" />
              )}
            </span>
            <div className="min-w-0">
              <p className={cn("text-sm", step.state === "idle" && "text-muted-foreground")}>{step.title}</p>
              {step.detail ? <p className="font-mono text-xs break-all text-muted-foreground">{step.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={verdict === "running"}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {verdict === "running" ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {verdict === "idle" ? "Verify in my browser" : verdict === "running" ? "Verifying…" : "Run again"}
        </button>
        {verdict === "verified" ? <span className="text-sm font-medium text-success">Verified independently by your browser.</span> : null}
        {verdict === "failed" ? <span className="text-sm font-medium text-destructive">Your browser could not verify this signature.</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Your browser contacts the 0G Chain RPC and the provider directly (they will see your IP address). Alactic is not involved in this check. A valid
        signature proves a TEE registered on 0G Chain signed this chat&apos;s encrypted exchange. It does not prove the answer is correct.
      </p>
    </div>
  );
}
