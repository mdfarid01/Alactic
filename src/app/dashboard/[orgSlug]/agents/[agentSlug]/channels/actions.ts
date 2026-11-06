"use server";

import { refresh } from "next/cache";
import { randomToken } from "@/server/auth/tokens";
import { requireUser } from "@/server/auth/dal";
import { connectorKey } from "@/server/connectors/registry";
import { createConnection, deleteConnection, setConnectionStatus } from "@/server/connectors/service";
import { discordApi, type DiscordCredentials } from "@/server/connectors/discord";
import { slackApi, type SlackCredentials } from "@/server/connectors/slack";
import { isTelegramToken, telegramApi, type TelegramCredentials } from "@/server/connectors/telegram";
import type { WhatsAppCredentials } from "@/server/connectors/whatsapp";
import { ConnectorError } from "@/server/connectors/types";
import { db } from "@/server/db/client";
import { appOrigin } from "@/server/env";
import { KnowledgeError } from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";

export type ChannelActionState = { ok?: boolean; error?: string; label?: string; mode?: string } | undefined;

async function adminScope(orgSlug: string) {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, "admin");
}

function toState(error: unknown): ChannelActionState {
  if (error instanceof ConnectorError || error instanceof KnowledgeError) return { error: error.message };
  throw error;
}

/**
 * Connect a business-owned Telegram bot: validate the token with getMe, store it encrypted, then register our webhook
 * with a random secret_token. On plain-http dev servers (no public HTTPS URL) the connection uses polling instead.
 */
export async function connectTelegramAction(orgSlug: string, agentSlug: string, botToken: string): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  const token = String(botToken ?? "").trim();
  if (!isTelegramToken(token)) return { error: "That doesn't look like a Telegram bot token (from @BotFather, e.g. 123456789:AA…)." };
  try {
    const key = connectorKey();
    const me = await telegramApi.getMe(token);
    if (!me.is_bot || !me.username) return { error: "That token doesn't belong to a bot." };
    const origin = appOrigin();
    const mode = origin.protocol === "https:" ? "webhook" : "polling";
    const credentials: TelegramCredentials = { botToken: token, secretToken: randomToken().slice(0, 64), botId: me.id, botUsername: me.username };
    const conn = await createConnection(db(), scope, agentSlug, { platform: "telegram", label: `@${me.username}`, externalId: String(me.id), credentials, deliveryMode: mode }, key);
    try {
      if (mode === "webhook") await telegramApi.setWebhook(token, `${origin.origin}/api/connectors/telegram/${conn.id}`, credentials.secretToken);
      else await telegramApi.deleteWebhook(token); // getUpdates only works without a webhook
    } catch (error) {
      await deleteConnection(db(), scope, agentSlug, conn.id, key);
      throw error;
    }
    refresh();
    return { ok: true, label: conn.label, mode };
  } catch (error) {
    return toState(error);
  }
}

export async function setChannelStatusAction(orgSlug: string, agentSlug: string, connectionId: string, active: boolean): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  try {
    await setConnectionStatus(db(), scope, agentSlug, connectionId, active ? "active" : "paused");
    refresh();
    return { ok: true };
  } catch (error) {
    return toState(error);
  }
}

/** Disconnect: delete stored credentials and (best effort) unregister the platform webhook. */
export async function disconnectChannelAction(orgSlug: string, agentSlug: string, connectionId: string): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  try {
    const removed = await deleteConnection<TelegramCredentials>(db(), scope, agentSlug, connectionId, connectorKey());
    if (removed.platform === "telegram" && removed.credentials) await telegramApi.deleteWebhook(removed.credentials.botToken).catch(() => {});
    refresh();
    return { ok: true };
  } catch (error) {
    return toState(error);
  }
}

const field = (v: unknown) => String(v ?? "").trim();

/**
 * Connect a WhatsApp Business number (business-owned Meta app). Credentials can't be checked until Meta calls our
 * webhook: the connection shows "waiting for verification" until the handshake succeeds.
 */
export async function connectWhatsAppAction(
  orgSlug: string,
  agentSlug: string,
  input: { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string; displayNumber: string },
): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  const phoneNumberId = field(input.phoneNumberId);
  const wabaId = field(input.wabaId);
  const accessToken = field(input.accessToken);
  const appSecret = field(input.appSecret);
  if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,30}$/.test(wabaId)) return { error: "Phone number ID and WhatsApp Business Account ID are numeric (App Dashboard → WhatsApp → API Setup)." };
  if (accessToken.length < 20 || appSecret.length < 16) return { error: "Paste the System User access token and the App Secret." };
  try {
    const credentials: WhatsAppCredentials = { phoneNumberId, wabaId, accessToken, appSecret, verifyToken: randomToken().slice(0, 40) };
    const label = field(input.displayNumber).slice(0, 40) || `Number ${phoneNumberId}`;
    const conn = await createConnection(db(), scope, agentSlug, { platform: "whatsapp", label, externalId: phoneNumberId, credentials, deliveryMode: "webhook" }, connectorKey());
    refresh();
    return { ok: true, label: conn.label, mode: "webhook" };
  } catch (error) {
    return toState(error);
  }
}

/** Connect a business-owned Slack app: validate the bot token with auth.test and store it with the signing secret. */
export async function connectSlackAction(orgSlug: string, agentSlug: string, input: { botToken: string; signingSecret: string }): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  const botToken = field(input.botToken);
  const signingSecret = field(input.signingSecret);
  if (!botToken.startsWith("xoxb-")) return { error: "Paste the Bot User OAuth Token (starts with xoxb-)." };
  if (!/^[0-9a-f]{16,128}$/i.test(signingSecret)) return { error: "Paste the Signing Secret from Basic Information → App Credentials." };
  try {
    const me = await slackApi.authTest(botToken);
    const credentials: SlackCredentials = { botToken, signingSecret, teamId: me.team_id, botUserId: me.user_id, botId: me.bot_id ?? null };
    const conn = await createConnection(db(), scope, agentSlug, { platform: "slack", label: me.team ? `${me.team} workspace` : `Workspace ${me.team_id}`, externalId: me.team_id, credentials, deliveryMode: "webhook" }, connectorKey());
    refresh();
    return { ok: true, label: conn.label, mode: "webhook" };
  } catch (error) {
    return toState(error);
  }
}

/** Connect a business-owned Discord application: validate the token, check the app id, register `/ask` + "Ask Alactic". */
export async function connectDiscordAction(orgSlug: string, agentSlug: string, input: { applicationId: string; publicKey: string; botToken: string }): Promise<ChannelActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to manage this agent's channels." };
  const applicationId = field(input.applicationId);
  const publicKey = field(input.publicKey).toLowerCase();
  const botToken = field(input.botToken);
  if (!/^\d{15,25}$/.test(applicationId)) return { error: "Application ID is a long number (General Information)." };
  if (!/^[0-9a-f]{64}$/.test(publicKey)) return { error: "Public Key is 64 hex characters (General Information)." };
  if (botToken.length < 50) return { error: "Paste the bot token (Bot → Reset Token)." };
  try {
    const app = await discordApi.getApplication(botToken);
    if (app.id !== applicationId) return { error: "That bot token belongs to a different application." };
    await discordApi.registerCommands(applicationId, botToken);
    const credentials: DiscordCredentials = { applicationId, publicKey, botToken };
    const conn = await createConnection(db(), scope, agentSlug, { platform: "discord", label: app.name, externalId: applicationId, credentials, deliveryMode: "webhook" }, connectorKey());
    refresh();
    return { ok: true, label: conn.label, mode: "webhook" };
  } catch (error) {
    return toState(error);
  }
}
