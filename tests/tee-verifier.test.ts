import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTeeSignature, type ServiceRecord } from "@/server/inference/tee-verifier";

const tee = privateKeyToAccount(generatePrivateKey()); // stands in for the enclave's signing key
const PROVIDER = "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250";
const CHAT = "6af50e76-65a1-4fc5-bd09-20c22dc7722c";
const TEXT = "zg-sig-v1/e2ee-ct:6f4062c0f4374aaecc68f594cf72037d90fb65d39ad870a310bcdbaacac0d394:5a7b4fd609c23a4b894b52848f72a63df73acb07eaab402a865d7afe2c4a98d2";

const service = (over: Partial<ServiceRecord> = {}): ServiceRecord => ({
  url: "https://compute-network-20.integratenetwork.work",
  model: "0GM-1.0-35B-A3B",
  verifiability: "TeeML",
  teeSignerAddress: tee.address,
  teeSignerAcknowledged: true,
  additionalInfo: JSON.stringify({ TEEVerifier: "dstack", TargetSeparated: false, TargetTeeAddress: "" }),
  ...over,
});
const sigResponse = async (signer = tee) =>
  new Response(JSON.stringify({ text: TEXT, signature: await signer.signMessage({ message: TEXT }), signing_address: signer.address, signing_algo: "ecdsa" }), { status: 200 });

describe("independent TEE verification", () => {
  it("verifies when the provider signature recovers to the on-chain acknowledged TEE signer", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      void url;
      return sigResponse();
    });
    const r = await verifyTeeSignature({ readService: async () => service(), fetchImpl: fetchImpl as unknown as typeof fetch }, { provider: PROVIDER, chatId: CHAT });
    expect(r).toMatchObject({ status: "verified", signerAddress: tee.address });
    expect(r.reason).toMatch(/encrypted exchange, not the displayed text/);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://compute-network-20.integratenetwork.work/v1/proxy/signature/${CHAT}?model=0GM-1.0-35B-A3B`);
    expect(r.details).toMatchObject({ signedTextFormat: "zg-sig-v1/e2ee-ct", signedTextSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("fails when someone else signed", async () => {
    const impostor = privateKeyToAccount(generatePrivateKey());
    const r = await verifyTeeSignature({ readService: async () => service(), fetchImpl: (async () => sigResponse(impostor)) as unknown as typeof fetch }, { provider: PROVIDER, chatId: CHAT });
    expect(r.status).toBe("failed");
  });

  it("fails for unacknowledged signers or non-verifiable services", async () => {
    const f = (async () => sigResponse()) as unknown as typeof fetch;
    expect((await verifyTeeSignature({ readService: async () => service({ teeSignerAcknowledged: false }), fetchImpl: f }, { provider: PROVIDER, chatId: CHAT })).status).toBe("failed");
    expect((await verifyTeeSignature({ readService: async () => service({ verifiability: "" }), fetchImpl: f }, { provider: PROVIDER, chatId: CHAT })).status).toBe("failed");
  });

  it("uses TargetTeeAddress when the target is separated (SDK rule)", async () => {
    const target = privateKeyToAccount(generatePrivateKey());
    const svc = service({ additionalInfo: JSON.stringify({ TargetSeparated: true, TargetTeeAddress: target.address }) });
    const ok = await verifyTeeSignature({ readService: async () => svc, fetchImpl: (async () => sigResponse(target)) as unknown as typeof fetch }, { provider: PROVIDER, chatId: CHAT });
    expect(ok.status).toBe("verified");
  });

  it("retries a 404 (signature not yet available) and then verifies", async () => {
    const responses = [new Response("{}", { status: 404 }), await sigResponse()];
    const r = await verifyTeeSignature(
      { readService: async () => service(), fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch, retryDelayMs: 1 },
      { provider: PROVIDER, chatId: CHAT },
    );
    expect(r.status).toBe("verified");
  });

  it("is 'unavailable' (never verified) when evidence can't be obtained", async () => {
    const f = (async () => sigResponse()) as unknown as typeof fetch;
    const read = async () => service();
    expect((await verifyTeeSignature({ readService: read, fetchImpl: f }, { provider: null, chatId: CHAT })).status).toBe("unavailable");
    expect((await verifyTeeSignature({ readService: read, fetchImpl: f }, { provider: PROVIDER, chatId: null })).status).toBe("unavailable");
    expect((await verifyTeeSignature({ readService: async () => { throw new Error("rpc"); }, fetchImpl: f }, { provider: PROVIDER, chatId: CHAT })).status).toBe("unavailable");
    expect((await verifyTeeSignature({ readService: read, fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch }, { provider: PROVIDER, chatId: CHAT })).status).toBe("unavailable");
  });

  it("refuses non-https or private signature endpoints from the registry", async () => {
    const f = vi.fn(async () => sigResponse());
    for (const url of ["http://compute.example.com", "https://localhost:8443", "https://10.0.0.5"]) {
      const r = await verifyTeeSignature({ readService: async () => service({ url }), fetchImpl: f as unknown as typeof fetch }, { provider: PROVIDER, chatId: CHAT });
      expect(r.status).toBe("unavailable");
    }
    expect(f).not.toHaveBeenCalled();
  });
});
