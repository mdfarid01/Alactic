import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import type { OrgRole } from "@/server/db/schema";
import { authorizeOrg, roleAtLeast } from "./service";

/** Resolve the org for a dashboard page. Non-members get a 404 (no hint that the org exists). */
export const getPageOrgScope = cache(async (orgSlug: string) => {
  const user = await requireUser(`/dashboard/${orgSlug}`);
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "member");
  if (!scope) notFound();
  return scope;
});

export async function requirePageOrgRole(orgSlug: string, minimum: OrgRole) {
  const scope = await getPageOrgScope(orgSlug);
  if (!roleAtLeast(scope.role, minimum)) notFound();
  return scope;
}
