import { and, asc, count, eq } from "drizzle-orm";
import { getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { organizationMembers, organizations, users, walletIdentities, type OrgRole } from "@/server/db/schema";

const ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

declare const orgScopeBrand: unique symbol;

/**
 * Proof that `userId` is a member of `orgId` with at least the checked role.
 * Only `authorizeOrg` creates one. Every tenant-scoped data function takes an OrgScope instead of a raw org id,
 * so tenant data cannot be queried without passing through an authorization check.
 */
export type OrgScope = {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgName: string;
  readonly userId: string;
  readonly role: OrgRole;
  readonly [orgScopeBrand]: true;
};

export const RESERVED_ORG_SLUGS = new Set([
  "admin", "api", "app", "auth", "dashboard", "docs", "help", "new", "settings", "sign-in", "signin",
  "status", "support", "www", "alactic", "embed", "public", "static",
]);

export const orgSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3–40 characters: lowercase letters, numbers and hyphens")
  .refine((s) => !RESERVED_ORG_SLUGS.has(s), "This name is reserved");

export const createOrgSchema = z.object({
  name: z.string().trim().min(2, "At least 2 characters").max(80, "At most 80 characters"),
  slug: orgSlugSchema,
});

export class OrgError extends Error {
  constructor(
    public readonly code: "slug_taken" | "forbidden" | "not_found" | "last_owner" | "invalid_input" | "already_member",
    message: string,
  ) {
    super(message);
  }
}

export async function createOrganization(db: Database, userId: string, input: z.input<typeof createOrgSchema>) {
  const parsed = createOrgSchema.safeParse(input);
  if (!parsed.success) throw new OrgError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  const { name, slug } = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name, slug, createdBy: userId })
        .returning({ id: organizations.id, slug: organizations.slug, name: organizations.name });
      await tx.insert(organizationMembers).values({ orgId: org.id, userId, role: "owner" });
      return org;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("slug_taken", "That URL is already taken");
    throw error;
  }
}

export async function listOrganizationsForUser(db: Database, userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.name));
}

/**
 * Authorization gate for everything inside an organization.
 * Returns null both when the org doesn't exist and when the user isn't a member, so callers can respond with
 * 404 and never reveal whether another tenant's org exists.
 */
export async function authorizeOrg(
  db: Database,
  userId: string,
  orgSlug: string,
  minimumRole: OrgRole = "member",
): Promise<OrgScope | null> {
  const slug = orgSlugSchema.safeParse(orgSlug);
  if (!slug.success) return null;
  const rows = await db
    .select({ orgId: organizations.id, orgSlug: organizations.slug, orgName: organizations.name, role: organizationMembers.role })
    .from(organizations)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, organizations.id), eq(organizationMembers.userId, userId)),
    )
    .where(eq(organizations.slug, slug.data))
    .limit(1);
  const row = rows[0];
  if (!row || !roleAtLeast(row.role, minimumRole)) return null;
  return { ...row, userId } as OrgScope;
}

export async function listMembers(db: Database, scope: OrgScope) {
  const rows = await db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role, address: walletIdentities.address, joinedAt: organizationMembers.createdAt })
    .from(organizationMembers)
    .leftJoin(walletIdentities, eq(walletIdentities.userId, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, scope.orgId))
    .orderBy(asc(organizationMembers.createdAt));
  return rows.map((r) => ({ ...r, address: r.address ? getAddress(r.address) : null }));
}

export const addMemberSchema = z.object({
  address: z.string().trim().refine((a) => isAddress(a, { strict: false }), "Enter a valid wallet address"),
  role: z.enum(["admin", "member", "owner"]),
});

/**
 * Add a member by wallet address. The wallet doesn't need to have signed in before: the membership applies once
 * that wallet signs in with SIWE (proving control of the address).
 * Admins may add members/admins; only owners may add owners.
 */
export async function addMemberByWallet(db: Database, scope: OrgScope, input: z.input<typeof addMemberSchema>) {
  if (!roleAtLeast(scope.role, "admin")) throw new OrgError("forbidden", "Only owners and admins can add members");
  const parsed = addMemberSchema.safeParse(input);
  if (!parsed.success) throw new OrgError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  if (parsed.data.role === "owner" && scope.role !== "owner") {
    throw new OrgError("forbidden", "Only owners can add owners");
  }
  const address = parsed.data.address.toLowerCase() as Hex;

  return db.transaction(async (tx) => {
    let userId = (
      await tx.select({ userId: walletIdentities.userId }).from(walletIdentities).where(eq(walletIdentities.address, address)).limit(1)
    )[0]?.userId;
    if (!userId) {
      const [user] = await tx.insert(users).values({}).returning({ id: users.id });
      await tx.insert(walletIdentities).values({ userId: user.id, address });
      userId = user.id;
    }
    const inserted = await tx
      .insert(organizationMembers)
      .values({ orgId: scope.orgId, userId, role: parsed.data.role })
      .onConflictDoNothing()
      .returning({ userId: organizationMembers.userId });
    if (inserted.length === 0) throw new OrgError("already_member", "That wallet is already a member");
    return { userId };
  });
}

/** Remove a member. Admins can remove members; only owners can remove admins/owners; the last owner can't be removed. */
export async function removeMember(db: Database, scope: OrgScope, targetUserId: string) {
  return db.transaction(async (tx) => {
    // Lock this org's membership rows so concurrent removals can't both pass the last-owner check.
    const members = await tx
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, scope.orgId))
      .for("update");
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw new OrgError("not_found", "Member not found");
    const removingSelf = targetUserId === scope.userId;
    if (!removingSelf) {
      if (!roleAtLeast(scope.role, "admin")) throw new OrgError("forbidden", "Only owners and admins can remove members");
      if (target.role !== "member" && scope.role !== "owner") throw new OrgError("forbidden", "Only owners can remove admins or owners");
    }
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length <= 1) {
      throw new OrgError("last_owner", "An organization must keep at least one owner");
    }
    await tx
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, scope.orgId), eq(organizationMembers.userId, targetUserId)));
  });
}

export async function countMembers(db: Database, scope: OrgScope) {
  const [row] = await db.select({ n: count() }).from(organizationMembers).where(eq(organizationMembers.orgId, scope.orgId));
  return row?.n ?? 0;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
