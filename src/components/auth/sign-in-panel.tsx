"use client";

import { Loader2, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage, type Connector } from "wagmi";
import { createSiweMessage } from "viem/siwe";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

type Step = "idle" | "connecting" | "signing" | "verifying";

function shorten(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Only allow same-site relative redirects after sign-in (no open redirect). */
function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}

export function SignInPanel({ next }: { next?: string }) {
  const router = useRouter();
  const connection = useConnection();
  // Typed loosely: EIP-6963 discovery adds wallets at runtime beyond the configured connector list.
  const allConnectors: readonly Connector[] = useConnectors();
  // `window.ethereum` only exists in the browser; check after mount to avoid a hydration mismatch.
  const hasInjectedProvider = useSyncExternalStore<boolean | null>(
    () => () => {},
    () => typeof (window as { ethereum?: unknown }).ethereum !== "undefined",
    () => null,
  );
  // Prefer named wallets discovered via EIP-6963; keep the generic "Injected" fallback only when it would work.
  const named = allConnectors.filter((c) => c.id !== "injected");
  const connectors =
    named.length > 0 ? named : hasInjectedProvider ? allConnectors.filter((c) => c.id === "injected") : [];
  const connect = useConnect();
  const disconnect = useDisconnect();
  const signMessage = useSignMessage();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  const busy = step !== "idle";

  async function signIn() {
    if (!connection.address || !connection.chainId) return;
    setError(null);
    try {
      setStep("signing");
      const nonceRes = await fetch("/api/auth/nonce", { method: "POST" });
      if (!nonceRes.ok) throw new Error("Could not start sign-in. Please try again.");
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      const now = new Date();
      const message = createSiweMessage({
        domain: window.location.host,
        uri: window.location.origin,
        address: connection.address,
        chainId: connection.chainId,
        nonce,
        version: "1",
        statement: "Sign in to Alactic. This request will not trigger a blockchain transaction or cost any gas.",
        issuedAt: now,
        expirationTime: new Date(now.getTime() + 5 * 60 * 1000),
      });
      const signature = await signMessage.mutateAsync({ message });

      setStep("verifying");
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Sign-in failed. Please try again.");
      }
      router.replace(safeNext(next));
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Sign-in failed.";
      setError(/rejected|denied/i.test(message) ? "Signature request was rejected in your wallet." : message);
      setStep("idle");
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">Sign in to Alactic</CardTitle>
        <CardDescription>
          Use your wallet to sign a one-time message. No transaction is sent and no gas is spent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection.isConnected && connection.address ? (
          <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-success" aria-hidden />
              <span className="font-mono">{shorten(connection.address)}</span>
              {connection.connector?.name ? (
                <span className="text-muted-foreground">via {connection.connector.name}</span>
              ) : null}
            </span>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => disconnect.mutate()}>
              Change
            </Button>
          </div>
        ) : hasInjectedProvider === null && named.length === 0 ? (
          <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
        ) : connectors.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No browser wallet detected. Install a wallet extension such as MetaMask or Rabby, then reload this page.
          </p>
        ) : (
          <div className="grid gap-2">
            {connectors.map((connector) => (
              <Button
                key={connector.uid}
                variant="outline"
                size="lg"
                className="justify-start"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  setStep("connecting");
                  try {
                    await connect.mutateAsync({ connector });
                  } catch (e) {
                    setError(e instanceof Error && /rejected/i.test(e.message) ? "Connection request was rejected." : "Could not connect to the wallet.");
                  } finally {
                    setStep("idle");
                  }
                }}
              >
                {connector.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- wallet-provided data: URI icon
                  <img src={connector.icon} alt="" className="size-5 rounded" />
                ) : (
                  <Wallet />
                )}
                {connector.name}
              </Button>
            ))}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <Button size="lg" disabled={!connection.isConnected || busy} onClick={signIn}>
          {busy && step !== "connecting" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {step === "signing" ? "Check your wallet…" : step === "verifying" ? "Verifying…" : "Sign in with Ethereum"}
        </Button>
        <p className="text-xs text-muted-foreground">
          The signature proves you control this address. Alactic never asks for your private key or seed phrase.
        </p>
      </CardFooter>
    </Card>
  );
}
