import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASK_MESSAGE_COMMAND, discordAdapter, parseDiscordInteraction, verifyDiscordSignature } from "@/server/connectors/discord";
import { escapeSlack, parseSlackEvent, slackAdapter, slackManifest, verifySlackSignature } from "@/server/connectors/slack";
import { parseWhatsAppWebhook, verifyWhatsAppSignature, whatsappAdapter } from "@/server/connectors/whatsapp";

describe("WhatsApp", () => {
  const secret = "app-secret-123456";
  const sig = (body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const payload = (messages: unknown[], phone = "PN1") => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phone }, messages } }] }],
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const body = JSON.stringify(payload([]));
    expect(verifyWhatsAppSignature(body, sig(body), secret)).toBe(true);
    expect(verifyWhatsAppSignature(body + " ", sig(body), secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, sig(body).replace("sha256=", ""), secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, null, secret)).toBe(false);
  });

  it("parses text, voice and image; uses the BSUID when the phone is missing; skips other numbers and statuses", () => {
    const parsed = parseWhatsAppWebhook(
      payload([
        { id: "wamid.1", from: "15550001", from_user_id: "US.1", type: "text", text: { body: "Hi" } },
        { id: "wamid.2", from_user_id: "US.2", type: "audio", audio: { id: "MEDIA2", voice: true } },
        { id: "wamid.3", from: "15550003", type: "image", image: { id: "MEDIA3", caption: "error?" } },
        { id: "wamid.4", from: "15550004", type: "sticker", sticker: { id: "S" } },
      ]),
      "PN1",
    );
    expect(parsed.messages).toEqual([
      { eventKey: "wa:wamid.1", externalChatId: "US.1", externalUserId: "US.1", text: "Hi", media: null, replyTarget: { to: "15550001", messageId: "wamid.1" } },
      { eventKey: "wa:wamid.2", externalChatId: "US.2", externalUserId: "US.2", text: "", media: { kind: "voice", ref: "MEDIA2" }, replyTarget: { recipient: "US.2", messageId: "wamid.2" } },
      { eventKey: "wa:wamid.3", externalChatId: "15550003", externalUserId: "15550003", text: "error?", media: { kind: "image", ref: "MEDIA3" }, replyTarget: { to: "15550003", messageId: "wamid.3" } },
    ]);
    expect(parsed.unsupported).toEqual([{ to: "15550004", messageId: "wamid.4" }]);
    expect(parseWhatsAppWebhook(payload([{ id: "x", from: "1", type: "text", text: { body: "hi" } }], "OTHER"), "PN1").messages).toHaveLength(0);
    const statuses = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, statuses: [{ id: "wamid.9", status: "read" }] } }] }] };
    expect(parseWhatsAppWebhook(statuses, "PN1")).toEqual({ messages: [], unsupported: [] });
  });

  it("sends text replies to the right recipient and only downloads media from Meta hosts with the token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/MEDIA1?")) return Response.json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", file_size: 4 });
      if (String(url).includes("/MEDIA2?")) return Response.json({ url: "https://evil.example/x", file_size: 4 });
      if (String(url).startsWith("https://lookaside")) return new Response(new Uint8Array([1, 2, 3, 4]));
      return Response.json({ messages: [{ id: "wamid.out" }] });
    }) as typeof fetch;
    const creds = { phoneNumberId: "PN1", wabaId: "W", accessToken: "TOKEN", appSecret: "s", verifyToken: "v" };
    const a = whatsappAdapter(fake);
    await a.sendReply(creds, { recipient: "US.2", messageId: "wamid.2" }, "Hello");
    expect(calls[0].url).toBe("https://graph.facebook.com/v27.0/PN1/messages");
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", recipient: "US.2", type: "text", text: { preview_url: false, body: "Hello" } });
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect((await a.downloadMedia(creds, "MEDIA1", 100)).bytes).toHaveLength(4);
    await expect(a.downloadMedia(creds, "MEDIA2", 100)).rejects.toThrow("Unexpected media host");
  });
});

describe("Slack", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5".replace(/[^0-9a-f]/g, "a");
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sign_ = (body: string, t = ts) => `v0=${createHmac("sha256", secret).update(`v0:${t}:${body}`).digest("hex")}`;
  const creds = { teamId: "T1", botUserId: "UBOT" };
  const env = (event: Record<string, unknown>, team = "T1") => ({ type: "event_callback", team_id: team, event_id: "Ev1", event });

  it("verifies v0 signatures and rejects stale timestamps", () => {
    const body = '{"type":"url_verification","challenge":"abc"}';
    expect(verifySlackSignature(body, ts, sign_(body), secret, now)).toBe(true);
    expect(verifySlackSignature(body, ts, sign_(body), secret, now + 6 * 60 * 1000)).toBe(false);
    expect(verifySlackSignature(body + "x", ts, sign_(body), secret, now)).toBe(false);
    expect(verifySlackSignature(body, null, sign_(body), secret, now)).toBe(false);
  });

  it("handles url_verification, mentions (threaded) and DMs; ignores bots, other teams and edits", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "abc" }, creds)).toEqual({ kind: "challenge", challenge: "abc" });
    expect(parseSlackEvent(env({ type: "app_mention", user: "U1", text: "<@UBOT> refund?", ts: "1.1", channel: "C1" }), creds)).toEqual({
      kind: "message",
      message: { eventKey: "sl:Ev1", externalChatId: "C1:1.1", externalUserId: "U1", text: "refund?", media: null, replyTarget: { channel: "C1", threadTs: "1.1" } },
    });
    const dm = parseSlackEvent(env({ type: "message", channel_type: "im", user: "U1", text: "hi", ts: "2.2", channel: "D1" }), creds);
    expect(dm.kind === "message" && dm.message.replyTarget).toEqual({ channel: "D1" });
    expect(parseSlackEvent(env({ type: "message", channel_type: "im", user: "UBOT", text: "hi", ts: "3", channel: "D1" }), creds).kind).toBe("ignore");
    expect(parseSlackEvent(env({ type: "message", channel_type: "im", user: "U1", bot_id: "B1", text: "hi", ts: "3", channel: "D1" }), creds).kind).toBe("ignore");
    expect(parseSlackEvent(env({ type: "message", channel_type: "im", subtype: "message_changed", user: "U1", text: "hi", ts: "3", channel: "D1" }), creds).kind).toBe("ignore");
    expect(parseSlackEvent(env({ type: "app_mention", user: "U1", text: "hi", ts: "3", channel: "C1" }, "T2"), creds).kind).toBe("ignore");
    expect(parseSlackEvent(env({ type: "message", channel_type: "channel", user: "U1", text: "hi", ts: "3", channel: "C1" }), creds).kind).toBe("ignore");
  });

  it("picks Slack-hosted files only, escapes output, and keeps the token on files.slack.com", async () => {
    const ev = env({ type: "message", subtype: "file_share", channel_type: "im", user: "U1", text: "", ts: "4", channel: "D1", files: [{ mimetype: "image/png", is_external: true, url_private: "https://x.example/a.png" }, { mimetype: "image/png", url_private: "https://files.slack.com/a.png" }] });
    const p = parseSlackEvent(ev, creds);
    expect(p.kind === "message" && p.message.media).toEqual({ kind: "image", ref: "https://files.slack.com/a.png" });
    expect(escapeSlack("<!channel> & <@U1>")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    const sent: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      sent.push(String(url));
      if (String(url).includes("chat.postMessage")) {
        expect(JSON.parse(String(init!.body))).toMatchObject({ channel: "C1", thread_ts: "1.1", text: "a &lt;b&gt;", unfurl_links: false });
        return Response.json({ ok: true });
      }
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    const a = slackAdapter(fake);
    const c = { botToken: "xoxb-1", signingSecret: secret, teamId: "T1", botUserId: "UBOT", botId: null };
    await a.sendReply(c, { channel: "C1", threadTs: "1.1" }, "a <b>");
    await expect(a.downloadMedia(c, "https://evil.example/f", 10)).rejects.toThrow("Unsupported file location");
    expect(sent).toEqual(["https://slack.com/api/chat.postMessage"]);
    expect(slackManifest("Acme Support").oauth_config.scopes.bot).toEqual(["app_mentions:read", "chat:write", "im:history", "files:read"]);
  });
});

describe("Discord", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
  const signed = (body: string, ts = "1700000000") => ({ ts, sig: sign(null, Buffer.from(ts + body), privateKey).toString("hex") });

  it("verifies Ed25519 signatures over timestamp + body", () => {
    const body = '{"type":1}';
    const { ts, sig } = signed(body);
    expect(verifyDiscordSignature(body, sig, ts, pubHex)).toBe(true);
    expect(verifyDiscordSignature(body + " ", sig, ts, pubHex)).toBe(false);
    expect(verifyDiscordSignature(body, sig, "1700000001", pubHex)).toBe(false);
    expect(verifyDiscordSignature(body, "00".repeat(64), ts, pubHex)).toBe(false);
    expect(verifyDiscordSignature(body, null, ts, pubHex)).toBe(false);
  });

  it("parses PING, /ask with an attachment, and the message command; rejects other apps", () => {
    const base = { id: "I1", application_id: "APP", token: "TOK", channel_id: "CH" };
    expect(parseDiscordInteraction({ ...base, type: 1 }, "APP")).toEqual({ kind: "ping" });
    expect(parseDiscordInteraction({ ...base, type: 1 }, "OTHER")).toEqual({ kind: "ignore" });
    const ask = parseDiscordInteraction(
      {
        ...base,
        type: 2,
        member: { user: { id: "U1" } },
        data: {
          name: "ask",
          type: 1,
          options: [{ name: "question", type: 3, value: "Why?" }, { name: "file", type: 11, value: "A1" }],
          resolved: { attachments: { A1: { id: "A1", url: "https://cdn.discordapp.com/attachments/1/2/s.png?ex=1", content_type: "image/png" } } },
        },
      },
      "APP",
    );
    expect(ask).toEqual({
      kind: "message",
      message: { eventKey: "dc:I1", externalChatId: "CH", externalUserId: "U1", text: "Why?", media: { kind: "image", ref: "https://cdn.discordapp.com/attachments/1/2/s.png?ex=1" }, replyTarget: { applicationId: "APP", token: "TOK" } },
    });
    const msgCmd = parseDiscordInteraction(
      { ...base, type: 2, user: { id: "U2" }, channel_id: undefined, data: { name: ASK_MESSAGE_COMMAND, type: 3, target_id: "M1", resolved: { messages: { M1: { content: "my order is late" } } } } },
      "APP",
    );
    expect(msgCmd.kind === "message" && msgCmd.message).toMatchObject({ text: "my order is late", externalChatId: "dm:U2", externalUserId: "U2" });
    expect(parseDiscordInteraction({ ...base, type: 2, member: { user: { id: "U1" } }, data: { name: "ask", type: 1, options: [{ name: "question", type: 3, value: "  " }] } }, "APP")).toEqual({ kind: "empty" });
  });

  it("edits the deferred reply with mentions disabled and only downloads from Discord's CDN", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const a = discordAdapter(fake);
    const creds = { applicationId: "APP", publicKey: pubHex, botToken: "BOT" };
    await a.sendReply(creds, { applicationId: "APP", token: "TOK" }, "@everyone hi");
    expect(calls[0].url).toBe("https://discord.com/api/v10/webhooks/APP/TOK/messages/@original");
    expect(calls[0].init!.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ content: "@everyone hi", allowed_mentions: { parse: [] } });
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBeUndefined();
    await expect(a.downloadMedia(creds, "https://evil.example/x.png", 10)).rejects.toThrow("Unsupported file location");
  });
});
