import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Building2 } from "lucide-react";
import { CreateOrgForm } from "@/components/dashboard/create-org-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { listOrganizationsForUser } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Organizations" };

export default function DashboardHome() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="mt-1 text-sm text-muted-foreground">Agents, knowledge and team members belong to an organization.</p>
      </div>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <Organizations />
      </Suspense>
    </div>
  );
}

async function Organizations() {
  const user = await requireUser("/dashboard");
  const orgs = await listOrganizationsForUser(db(), user.userId);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        {orgs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Building2 className="size-8 text-muted-foreground" aria-hidden />
              <p className="font-medium">No organizations yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create your first organization to start building agents. If a teammate added your wallet to theirs, it
                will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          orgs.map((org) => (
            <Link
              key={org.id}
              href={`/dashboard/${org.slug}`}
              className="group flex items-center justify-between rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted font-semibold uppercase">
                  {org.name.slice(0, 1)}
                </span>
                <div>
                  <p className="font-medium">{org.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">/{org.slug}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="capitalize">{org.role}</Badge>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>New organization</CardTitle>
          <CardDescription>You&apos;ll be its owner. You can add teammates by wallet address afterwards.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm />
        </CardContent>
      </Card>
    </div>
  );
}
