import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSession, findSessionByToken, revokeSessionByToken, SESSION_TTL_MS, upsertWalletUser } from "@/server/auth/sessions";
import { setupTestDb } from "./helpers/db";
import { sessions } from "@/server/db/schema";

const db = setupTestDb();

describe("sessions", () => {
  it("creates a session, finds it by token, and stores only the token hash", async () => {
    const { address } = privateKeyToAccount(generatePrivateKey());
    const userId = await upsertWalletUser(db, address);
    const { token } = await createSession(db, { userId, walletAddress: address });

    const found = await findSessionByToken(db, token);
    expect(found?.userId).toBe(userId);
    expect(found?.walletAddress).toBe(address);

    const stored = await db.select().from(sessions);
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toBe(token);
    expect(stored[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps the same wallet to the same user across sign-ins (case-insensitive)", async () => {
    const { address } = privateKeyToAccount(generatePrivateKey());
    const a = await upsertWalletUser(db, address);
    const b = await upsertWalletUser(db, address.toLowerCase() as `0x${string}`);
    expect(a).toBe(b);
  });

  it("revoked sessions are rejected", async () => {
    const { address } = privateKeyToAccount(generatePrivateKey());
    const userId = await upsertWalletUser(db, address);
    const { token } = await createSession(db, { userId, walletAddress: address });
    await revokeSessionByToken(db, token);
    expect(await findSessionByToken(db, token)).toBeNull();
  });

  it("expired sessions are rejected", async () => {
    const { address } = privateKeyToAccount(generatePrivateKey());
    const userId = await upsertWalletUser(db, address);
    const { token } = await createSession(db, { userId, walletAddress: address });
    const afterExpiry = new Date(Date.now() + SESSION_TTL_MS + 1000);
    expect(await findSessionByToken(db, token, afterExpiry)).toBeNull();
  });

  it("unknown or oversized tokens are rejected", async () => {
    expect(await findSessionByToken(db, "nope")).toBeNull();
    expect(await findSessionByToken(db, "x".repeat(500))).toBeNull();
  });
});
