import { Suspense } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { OrgNav } from "@/components/dashboard/org-nav";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getPageOrgScope } from "@/server/orgs/page-scope";

export default function OrgLayout({ children, params }: LayoutProps<"/dashboard/[orgSlug]">) {
  return (
    <div className="space-y-8">
      <div className="space-y-4 border-b">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> All organizations
        </Link>
        <Suspense fallback={<Skeleton className="h-8 w-56" />}>
          <OrgHeader params={params} />
        </Suspense>
        <Suspense fallback={<div className="h-10" />}>
          <OrgTabs params={params} />
        </Suspense>
      </div>
      {children}
    </div>
  );
}

async function OrgHeader({ params }: { params: LayoutProps<"/dashboard/[orgSlug]">["params"] }) {
  const { orgSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{scope.orgName}</h1>
      <Badge variant="secondary" className="capitalize">{scope.role}</Badge>
    </div>
  );
}

async function OrgTabs({ params }: { params: LayoutProps<"/dashboard/[orgSlug]">["params"] }) {
  const { orgSlug } = await params;
  return <OrgNav orgSlug={orgSlug} />;
}
