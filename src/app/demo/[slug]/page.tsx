import { Suspense } from "react";
import Script from "next/script";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Widget demo" };

/** A stand-in "customer website" that embeds the widget exactly like a real site would. */
export default function WidgetDemo({ params }: PageProps<"/demo/[slug]">) {
  return (
    <Suspense fallback={null}>
      <Demo params={params} />
    </Suspense>
  );
}

async function Demo({ params }: { params: PageProps<"/demo/[slug]">["params"] }) {
  const { slug } = await params;
  return (
    <div className="min-h-dvh bg-[#faf7f2] text-[#2b2118]">
      <header className="border-b border-[#e8dfd3] bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <span className="text-lg font-semibold">Example store</span>
          <nav className="flex gap-6 text-sm text-[#6b5b4b]">
            <span>Shop</span>
            <span>Subscriptions</span>
            <span>Help</span>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm font-medium tracking-wide text-[#a0763f] uppercase">Widget demo</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">This page simulates a customer&apos;s website.</h1>
        <p className="mt-4 max-w-2xl text-[#6b5b4b]">
          The chat bubble in the corner is the Alactic widget, added with a single script tag. It runs in an isolated frame and
          answers using the agent&apos;s published knowledge on 0G Compute.
        </p>
        <pre className="mt-8 overflow-x-auto rounded-lg bg-[#2b2118] p-4 text-sm text-[#faf7f2]">{`<script src="/widget.js" data-agent="${slug}" async></script>`}</pre>
      </main>
      <Script src="/widget.js" data-agent={slug} strategy="afterInteractive" />
    </div>
  );
}
