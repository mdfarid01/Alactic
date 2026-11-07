import type { ConnectorPlatform } from "@/server/db/schema";

/** A message received from a platform, normalized. Serializable (it travels through the job queue). */
export type InboundMessage = {
  /** Unique per connection; used to drop webhook retries. */
  eventKey: string;
  /** Thread key on the platform (chat id, channel+thread, ticket id…). One conversation per thread. */
  externalChatId: string;
  /** The person writing. Hashed before storage; used for per-user rate limits. */
  externalUserId: string;
  text: string;
  /** Platform media reference (file id / media id / URL) to download in the job. */
  media: { kind: "voice" | "image"; ref: string } | null;
  /** Where to send the reply (platform-specific: chat id, message id to reply to, thread ts…). */
  replyTarget: Record<string, string | number>;
};

export type DownloadedMedia = { bytes: Uint8Array };

/** What each platform implements. Adapters only translate; all AI logic stays in runAgent. */
export interface ConnectorAdapter<Creds = unknown> {
  platform: ConnectorPlatform;
  /** Max characters per reply message on this platform (we truncate before the proof footer). */
  maxReplyChars: number;
  downloadMedia(creds: Creds, ref: string, maxBytes: number): Promise<DownloadedMedia>;
  sendReply(creds: Creds, target: InboundMessage["replyTarget"], text: string): Promise<void>;
  sendTyping?(creds: Creds, target: InboundMessage["replyTarget"]): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    public readonly code: "invalid_credentials" | "platform_error" | "forbidden" | "not_found" | "invalid_input" | "not_configured" | "too_large",
    message: string,
  ) {
    super(message);
  }
}
