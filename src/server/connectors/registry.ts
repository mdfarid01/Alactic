import "server-only";
import type { ConnectorPlatform } from "@/server/db/schema";
import { env } from "@/server/env";
import { parseKey } from "./crypto";
import { discordAdapter } from "./discord";
import { slackAdapter } from "./slack";
import { telegramAdapter } from "./telegram";
import { whatsappAdapter } from "./whatsapp";
import { ConnectorError, type ConnectorAdapter } from "./types";

export function connectorKey(): Buffer {
  const k = env().CONNECTOR_ENCRYPTION_KEY;
  if (!k) throw new ConnectorError("not_configured", "Channels aren't configured on this server (CONNECTOR_ENCRYPTION_KEY missing).");
  return parseKey(k);
}

export function connectorsConfigured(): boolean {
  try {
    connectorKey();
    return true;
  } catch {
    return false;
  }
}

/** Adapters available today. Platforms not listed here are shown as "coming soon" in the UI. */
export function adapterFor(platform: ConnectorPlatform): ConnectorAdapter<never> | null {
  switch (platform) {
    case "telegram":
      return telegramAdapter() as ConnectorAdapter<never>;
    case "whatsapp":
      return whatsappAdapter() as ConnectorAdapter<never>;
    case "slack":
      return slackAdapter() as ConnectorAdapter<never>;
    case "discord":
      return discordAdapter() as ConnectorAdapter<never>;
    default:
      return null;
  }
}
