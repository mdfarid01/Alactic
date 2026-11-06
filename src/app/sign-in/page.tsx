import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Brand } from "@/components/layout/brand";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { getCurrentUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <Brand />
      <Suspense fallback={<div className="h-80 w-full max-w-md animate-pulse rounded-xl border bg-muted/30" />}>
        <SignIn searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function SignIn({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;
  if (await getCurrentUser()) {
    redirect(nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/dashboard");
  }
  return <SignInPanel next={nextPath} />;
}
