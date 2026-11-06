import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Cpu,
  FileText,
  Fingerprint,
  Globe,
  Lock,
  MessageSquare,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function LandingPage() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Brand />
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#how-it-works" className="hover:text-foreground">How it works</a>
            <a href="#verification" className="hover:text-foreground">Verification</a>
            <a href="#identity" className="hover:text-foreground">Identity</a>
            <a href="#channels" className="hover:text-foreground">Channels</a>
          </nav>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Link href="/sign-in" className={buttonVariants({ size: "sm" })}>
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklch,var(--brand)_14%,transparent),transparent)]"
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 md:py-28 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <Badge variant="outline" className="mb-6 gap-1.5">
                <span className="size-1.5 rounded-full bg-brand" aria-hidden />
                Early access · in active development
              </Badge>
              <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Verifiable AI support agents for every business.
              </h1>
              <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
                Train a support agent on your website, documents and FAQs. Answers run on 0G Compute with
                hardware-verified execution, cite their sources, and every agent gets a public ENS identity.
              </p>
              <p className="mt-3 text-sm font-medium tracking-tight">Create once. Own your identity. Deploy everywhere.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/sign-in" className={buttonVariants({ size: "lg" })}>
                  Start building <ArrowRight />
                </Link>
                <a href="#how-it-works" className={buttonVariants({ size: "lg", variant: "outline" })}>
                  How it works
                </a>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Your customers chat without a wallet. Your wallet is only used to sign in and manage your agents.
              </p>
            </div>

            <ExampleConversation />
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-16 border-b">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <SectionHeading
              eyebrow="How it works"
              title="From your knowledge to a support agent you can deploy"
              description="No blockchain knowledge required. Alactic handles inference, identity and deployment."
            />
            <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {[
                { icon: Wallet, title: "Sign in & create an organization", body: "Sign in with your wallet. Invite teammates by wallet address with owner, admin or member roles." },
                { icon: BookOpen, title: "Add your knowledge", body: "Point Alactic at your website, upload PDFs and documents, or write FAQ entries. Everything is indexed with source metadata." },
                { icon: MessageSquare, title: "Configure & test", body: "Set the agent's name, tone, language, instructions and fallback answer. Try it in the playground with citations." },
                { icon: Globe, title: "Publish", body: "Get a public chat page, an embeddable website widget and an ENS name. Connect more channels as they become available." },
              ].map((step, i) => (
                <li key={step.title} className="rounded-xl border bg-card p-5">
                  <div className="flex items-center justify-between">
                    <step.icon className="size-5 text-brand" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                  </div>
                  <h3 className="mt-4 font-medium">{step.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Verification */}
        <section id="verification" className="scroll-mt-16 border-b">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2">
            <div>
              <SectionHeading
                eyebrow="Verifiable inference"
                title="Know where every answer was computed"
                description="Customer-facing answers are generated on the 0G Compute Network. You choose the trust mode per agent, and Alactic never silently downgrades it: if a mode is unavailable, the agent says so instead."
              />
              <p className="mt-6 rounded-lg border-l-2 border-brand bg-muted/40 p-4 text-sm text-muted-foreground">
                Verification proves which TEE-hosted model produced a response. It does not prove the response is
                correct. That&apos;s why every answer cites the sources it was based on.
              </p>
            </div>
            <div className="grid gap-3">
              <TrustMode
                icon={Lock}
                name="Private"
                tag="Recommended"
                body="The model runs inside a hardware enclave (Intel TDX). Prompts enter encrypted and responses are signed inside the enclave. The 0G Router keeps billing metadata only."
              />
              <TrustMode
                icon={ShieldCheck}
                name="Verified"
                body="Responses come with proof of the provider that produced them. Some providers relay to an upstream model service that processes prompts under its own data policy."
              />
              <TrustMode
                icon={Cpu}
                name="Standard"
                body="The broadest model choice, with no attestation. Responses can't be verified and are labelled that way."
              />
            </div>
          </div>
        </section>

        {/* Identity */}
        <section id="identity" className="scroll-mt-16 border-b">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
            <ExampleIdentity />
            <div className="lg:order-first">
              <SectionHeading
                eyebrow="ENS identity"
                title="A public name your customers can check"
                description="Each published agent gets a name like acme.alactic.eth that resolves to its public chat page and a versioned manifest describing how it runs. Already own an ENS name? Link it, and the identity is yours."
              />
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  "Standard agent records (ENSIP-26, draft) that other apps and agents can resolve",
                  "Clear labels: “Managed by Alactic” vs. “Owned by you”",
                  "Only public information is published. Instructions and documents stay private",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                    <span className="text-muted-foreground">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Channels */}
        <section id="channels" className="scroll-mt-16 border-b">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <SectionHeading
              eyebrow="Channels"
              title="One agent, every place your customers ask"
              description="Every channel uses the same agent, knowledge and inference pipeline. The status below reflects what is available today."
            />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { name: "Website chat & widget", body: "Public chat page and an embeddable widget." },
                { name: "Discord", body: "Answer questions in your community server." },
                { name: "Slack", body: "Support customers and teams in Slack." },
                { name: "Zendesk", body: "Draft and send replies on support tickets." },
              ].map((c) => (
                <div key={c.name} className="rounded-xl border bg-card p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium">{c.name}</h3>
                    <Badge variant="secondary">Planned</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section>
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-20 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Build your first agent</h2>
              <p className="mt-2 text-muted-foreground">Sign in with your wallet and create an organization to get started.</p>
            </div>
            <Link href="/sign-in" className={buttonVariants({ size: "lg" })}>
              Start building <ArrowRight />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <Brand className="text-foreground" />
          <p>Inference on 0G Compute · Identity on ENS</p>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-medium text-brand">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{title}</h2>
      <p className="mt-4 text-pretty text-muted-foreground">{description}</p>
    </div>
  );
}

function TrustMode({ icon: Icon, name, body, tag }: { icon: typeof Lock; name: string; body: string; tag?: string }) {
  return (
    <div className="flex gap-4 rounded-xl border bg-card p-5">
      <Icon className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
      <div>
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{name}</h3>
          {tag ? <Badge variant="outline">{tag}</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function IllustrationLabel() {
  return <span className="text-[11px] tracking-wide text-muted-foreground uppercase">Illustrative example</span>;
}

function ExampleConversation() {
  return (
    <figure className="rounded-2xl border bg-card p-4 shadow-sm" aria-label="Illustrative example of an Alactic support conversation">
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">A</span>
          <div className="leading-tight">
            <p className="text-sm font-medium">Acme Support</p>
            <p className="font-mono text-[11px] text-muted-foreground">acme.alactic.eth</p>
          </div>
        </div>
        <IllustrationLabel />
      </div>
      <div className="space-y-3 py-4 text-sm">
        <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground">
          Can I return an order after 30 days?
        </p>
        <div className="max-w-[90%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2">
          <p>
            Returns are accepted within 45 days of delivery for unused items. After that, you can still request a repair
            under warranty <span className="font-mono text-xs text-brand">[1]</span>.
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3.5" aria-hidden /> [1] Returns &amp; refunds · acme.com/help/returns
          </p>
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
        <Badge variant="outline" className="gap-1">
          <Lock className="size-3" aria-hidden /> Private (TEE)
        </Badge>
        <Badge variant="outline" className="gap-1 border-success/40 text-success">
          <ShieldCheck className="size-3" aria-hidden /> TEE signature verified
        </Badge>
        <span className="text-muted-foreground">Verification ≠ correctness</span>
      </figcaption>
    </figure>
  );
}

function ExampleIdentity() {
  const records: Array<[string, string]> = [
    ["agent-endpoint[web]", "https://…/a/acme"],
    ["agent-context", "Customer support agent for Acme…"],
    ["description", "Answers questions about Acme orders"],
    ["manifest-sha256", "9f2c…e41a"],
  ];
  return (
    <figure className="rounded-2xl border bg-card p-5 shadow-sm" aria-label="Illustrative example of an agent's ENS records">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Fingerprint className="size-5 text-brand" aria-hidden />
          <div>
            <p className="font-mono text-sm font-medium">acme.alactic.eth</p>
            <p className="text-xs text-muted-foreground">Managed by Alactic</p>
          </div>
        </div>
        <IllustrationLabel />
      </div>
      <dl className="mt-5 divide-y rounded-lg border text-sm">
        {records.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 px-3 py-2">
            <dt className="truncate font-mono text-xs text-muted-foreground">{k}</dt>
            <dd className={cn("truncate", k === "manifest-sha256" && "font-mono text-xs")}>{v}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}
