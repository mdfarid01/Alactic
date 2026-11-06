import { Suspense } from "react";
import type { Metadata } from "next";
import { AddMemberForm } from "@/components/dashboard/add-member-form";
import { RemoveMemberButton } from "@/components/dashboard/remove-member-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { listMembers, roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage({ params }: PageProps<"/dashboard/[orgSlug]/members">) {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <Members params={params} />
    </Suspense>
  );
}

async function Members({ params }: { params: PageProps<"/dashboard/[orgSlug]/members">["params"] }) {
  const { orgSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const members = await listMembers(db(), scope);
  const canManage = roleAtLeast(scope.role, "admin");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Everyone with access to this organization.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {members.map((m) => {
            const isSelf = m.userId === scope.userId;
            const canRemove = isSelf || (canManage && (m.role === "member" || scope.role === "owner"));
            return (
              <div key={m.userId} className="flex items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{m.address ?? "Unknown wallet"}</p>
                  {isSelf ? <p className="text-xs text-muted-foreground">You</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={m.role === "owner" ? "default" : "secondary"} className="capitalize">{m.role}</Badge>
                  {canRemove ? <RemoveMemberButton orgSlug={scope.orgSlug} userId={m.userId} isSelf={isSelf} /> : null}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a member</CardTitle>
            <CardDescription>Grant access to a teammate&apos;s wallet.</CardDescription>
          </CardHeader>
          <CardContent>
            <AddMemberForm orgSlug={scope.orgSlug} canAddOwners={scope.role === "owner"} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Roles</CardTitle>
            <CardDescription>Only owners and admins can add or remove members.</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
