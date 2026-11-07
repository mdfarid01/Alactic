import type { Attachment } from "@/server/runtime/attachments";

export const MEDIA_LIMITS = {
  /** ~60 s of browser-recorded Opus is ~0.5 MB; WAV/M4A uploads are larger. */
  audioMaxBytes: 4 * 1024 * 1024,
  /** Base64 adds ~33%; the Router's request cap is 20 MB. */
  imageMaxBytes: 4 * 1024 * 1024,
} as const;

export class MediaError extends Error {
  constructor(public readonly code: "too_large" | "unsupported_type" | "empty", message: string) {
    super(message);
  }
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Uint8Array, s: string, offset = 0) => startsWith(b, [...s].map((c) => c.charCodeAt(0)), offset);

/** Detect the audio container from its magic bytes (the declared MIME type is not trusted). */
export function sniffAudio(b: Uint8Array): { mime: string; ext: string } | null {
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "audio/webm", ext: "webm" };
  if (ascii(b, "OggS")) return { mime: "audio/ogg", ext: "ogg" };
  if (ascii(b, "RIFF") && ascii(b, "WAVE", 8)) return { mime: "audio/wav", ext: "wav" };
  if (ascii(b, "ftyp", 4)) return { mime: "audio/mp4", ext: "m4a" };
  if (ascii(b, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ext: "mp3" };
  return null;
}

export function sniffImage(b: Uint8Array): { mime: string } | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg" };
  if (ascii(b, "RIFF") && ascii(b, "WEBP", 8)) return { mime: "image/webp" };
  if (ascii(b, "GIF87a") || ascii(b, "GIF89a")) return { mime: "image/gif" };
  return null;
}

/** Validate an uploaded file and turn it into a runtime attachment. Throws MediaError with a visitor-safe message. */
export async function toAttachment(kind: "voice" | "image", file: File): Promise<Attachment> {
  const max = kind === "voice" ? MEDIA_LIMITS.audioMaxBytes : MEDIA_LIMITS.imageMaxBytes;
  if (file.size === 0) throw new MediaError("empty", "The file is empty.");
  if (file.size > max) throw new MediaError("too_large", kind === "voice" ? "Voice notes can be up to about a minute long." : "Images can be up to 4 MB.");
  return attachmentFromBytes(kind, new Uint8Array(await file.arrayBuffer()));
}

/** Same validation for bytes downloaded from a platform (Telegram, WhatsApp, Slack…). */
export function attachmentFromBytes(kind: "voice" | "image", bytes: Uint8Array): Attachment {
  const max = kind === "voice" ? MEDIA_LIMITS.audioMaxBytes : MEDIA_LIMITS.imageMaxBytes;
  if (bytes.length === 0) throw new MediaError("empty", "The file is empty.");
  if (bytes.length > max) throw new MediaError("too_large", kind === "voice" ? "Voice notes can be up to about a minute long." : "Images can be up to 4 MB.");
  if (kind === "voice") {
    const t = sniffAudio(bytes);
    if (!t) throw new MediaError("unsupported_type", "That audio format isn't supported.");
    return { kind: "voice", bytes, mime: t.mime, filename: `voice.${t.ext}` };
  }
  const t = sniffImage(bytes);
  if (!t) throw new MediaError("unsupported_type", "Please send a PNG, JPEG, WebP or GIF image.");
  return { kind: "image", bytes, mime: t.mime };
}
