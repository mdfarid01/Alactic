import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import {
  addMemberByWallet,
  authorizeOrg,
  createOrganization,
  listMembers,
  listOrganizationsForUser,
  OrgError,
  removeMember,
} from "@/server/orgs/service";
import { setupTestDb } from "./helpers/db";

const db = setupTestDb();

async function newUser() {
  const { address } = privateKeyToAccount(generatePrivateKey());
  return { address, userId: await upsertWalletUser(db, address) };
}

describe("organizations & tenant isolation", () => {
  it("creator becomes owner and can access the org", async () => {
    const alice = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const scope = await authorizeOrg(db, alice.userId, "acme", "owner");
    expect(scope?.role).toBe("owner");
    expect(await listOrganizationsForUser(db, alice.userId)).toHaveLength(1);
  });

  it("a non-member gets null (same as a non-existent org), never another tenant's scope", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    await createOrganization(db, mallory.userId, { name: "Evil", slug: "evil" });

    expect(await authorizeOrg(db, mallory.userId, "acme")).toBeNull();
    expect(await authorizeOrg(db, mallory.userId, "does-not-exist")).toBeNull();
    expect((await listOrganizationsForUser(db, mallory.userId)).map((o) => o.slug)).toEqual(["evil"]);
  });

  it("role minimums are enforced", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const owner = (await authorizeOrg(db, alice.userId, "acme"))!;
    await addMemberByWallet(db, owner, { address: bob.address, role: "member" });

    expect(await authorizeOrg(db, bob.userId, "acme", "member")).not.toBeNull();
    expect(await authorizeOrg(db, bob.userId, "acme", "admin")).toBeNull();
  });

  it("members cannot add members; admins cannot add owners", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const owner = (await authorizeOrg(db, alice.userId, "acme"))!;
    await addMemberByWallet(db, owner, { address: bob.address, role: "member" });
    const bobScope = (await authorizeOrg(db, bob.userId, "acme"))!;
    await expect(addMemberByWallet(db, bobScope, { address: carol.address, role: "member" })).rejects.toMatchObject({
      code: "forbidden",
    });

    await addMemberByWallet(db, owner, { address: carol.address, role: "admin" });
    const carolScope = (await authorizeOrg(db, carol.userId, "acme"))!;
    const dave = await newUser();
    await expect(addMemberByWallet(db, carolScope, { address: dave.address, role: "owner" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("adding a wallet that never signed in links once that wallet signs in", async () => {
    const alice = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const owner = (await authorizeOrg(db, alice.userId, "acme"))!;
    const { address } = privateKeyToAccount(generatePrivateKey());
    await addMemberByWallet(db, owner, { address, role: "member" });
    const laterUserId = await upsertWalletUser(db, address); // first SIWE sign-in
    expect(await authorizeOrg(db, laterUserId, "acme")).not.toBeNull();
    expect((await listMembers(db, owner)).map((m) => m.address)).toContain(address);
  });

  it("the last owner cannot be removed", async () => {
    const alice = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const owner = (await authorizeOrg(db, alice.userId, "acme"))!;
    await expect(removeMember(db, owner, alice.userId)).rejects.toMatchObject({ code: "last_owner" });
  });

  it("only owners remove admins; admins can remove members", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    const owner = (await authorizeOrg(db, alice.userId, "acme"))!;
    await addMemberByWallet(db, owner, { address: bob.address, role: "admin" });
    await addMemberByWallet(db, owner, { address: carol.address, role: "admin" });
    const bobScope = (await authorizeOrg(db, bob.userId, "acme"))!;
    await expect(removeMember(db, bobScope, carol.userId)).rejects.toBeInstanceOf(OrgError);
    await removeMember(db, owner, carol.userId);
    expect(await authorizeOrg(db, carol.userId, "acme")).toBeNull();
  });

  it("scopes can't be used across orgs: a scope for org A never lists org B's members", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    await createOrganization(db, mallory.userId, { name: "Evil", slug: "evil" });
    const evilScope = (await authorizeOrg(db, mallory.userId, "evil"))!;
    const members = await listMembers(db, evilScope);
    expect(members.map((m) => m.userId)).toEqual([mallory.userId]);
  });

  it("validates slugs and rejects duplicates and reserved names", async () => {
    const alice = await newUser();
    await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
    await expect(createOrganization(db, alice.userId, { name: "Acme 2", slug: "acme" })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(createOrganization(db, alice.userId, { name: "Bad", slug: "Bad Slug!" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createOrganization(db, alice.userId, { name: "Admin", slug: "admin" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
