"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { addMemberByWallet, authorizeOrg, createOrganization, OrgError, removeMember } from "@/server/orgs/service";

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
