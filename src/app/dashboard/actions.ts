"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { generateDigest } from "@/server/digest/service";
import { runtimeDeps } from "@/server/inference/config";
import { addMemberByWallet, authorizeOrg, createOrganization, OrgError, removeMember } from "@/server/orgs/service";
import { consumeRateLimits } from "@/server/ratelimit/limiter";

export type FormState = { error?: string; ok?: boolean } | undefined;

export async function createOrganizationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  let slug: string;
  try {
    const org = await createOrganization(db(), user.userId, {
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
    });
    slug = org.slug;
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
  redirect(`/dashboard/${slug}`);
}

export async function addMemberAction(orgSlug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "admin");
  if (!scope) return { error: "You don't have permission to add members." };
  try {
    await addMemberByWallet(db(), scope, {
      address: String(formData.get("address") ?? ""),
      role: String(formData.get("role") ?? "member") as "member",
    });
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

export async function removeMemberAction(orgSlug: string, targetUserId: string): Promise<FormState> {
  const user = await requireUser();
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "member");
  if (!scope) return { error: "Organization not found." };
  try {
    await removeMember(db(), scope, targetUserId);
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
  if (targetUserId === user.userId) redirect("/dashboard");
  refresh();
  return { ok: true };
}

/** Regenerate today's briefing for an org (admins; at most every 10 minutes). */
export async function refreshDigestAction(orgSlug: string): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireUser();
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "admin");
  if (!scope) return { error: "Only admins can refresh the briefing." };
  const limited = await consumeRateLimits(db(), [{ key: `digest:org:${scope.orgId}`, limit: 1, windowSeconds: 10 * 60 }]);
  if (!limited.ok) return { error: "The briefing was refreshed recently. Try again in a few minutes." };
  await generateDigest(runtimeDeps(), scope.orgId);
  refresh();
  return { ok: true };
}
