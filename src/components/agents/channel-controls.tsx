"use client";

import { useState, useTransition } from "react";
import { Link2, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  connectDiscordAction,
  connectSlackAction,
  connectTelegramAction,
  connectWhatsAppAction,
  disconnectChannelAction,
  setChannelStatusAction,
} from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/channels/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TelegramConnectForm({ orgSlug, agentSlug, disabled }: { orgSlug: string; agentSlug: string; disabled: boolean }) {
  const [token, setToken] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await connectTelegramAction(orgSlug, agentSlug, token);
          if (r?.error) toast.error(r.error);
          else {
            setToken("");
            toast.success(r?.mode === "polling" ? `${r.label} connected (local polling mode).` : `${r?.label} connected. Message your bot to try it.`);
          }
        });
      }}
    >
      <label className="block space-y-1 text-xs text-muted-foreground">
        Bot token from @BotFather
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456789:AA…"
          className="font-mono"
          disabled={disabled || pending}
        />
      </label>
      <Button type="submit" size="sm" disabled={disabled || pending || !token.trim()}>
        <Link2 /> Connect Telegram bot
      </Button>
    </form>
  );
}

export function ConnectionActions({ orgSlug, agentSlug, connectionId, status, canEdit }: { orgSlug: string; agentSlug: string; connectionId: string; status: string; canEdit: boolean }) {
  const [pending, start] = useTransition();
  if (!canEdit) return null;
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={status === "active" ? "Pause" : "Resume"}
        onClick={() =>
          start(async () => {
            const r = await setChannelStatusAction(orgSlug, agentSlug, connectionId, status !== "active");
            if (r?.error) toast.error(r.error);
          })
        }
      >
        {status === "active" ? <Pause /> : <Play />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label="Disconnect"
        onClick={() =>
          start(async () => {
            if (!confirm("Disconnect this channel? The stored credentials are deleted.")) return;
            const r = await disconnectChannelAction(orgSlug, agentSlug, connectionId);
            if (r?.error) toast.error(r.error);
            else toast.success("Disconnected.");
          })
        }
      >
        <Trash2 />
      </Button>
    </div>
  );
}

type FieldDef = { name: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean };

/** Generic credentials form; values go straight to a server action and are never stored in the browser. */
export function CredentialsForm({
  fields,
  submitLabel,
  disabled,
  onSubmit,
}: {
  fields: FieldDef[];
  submitLabel: string;
  disabled: boolean;
  onSubmit: (values: Record<string, string>) => Promise<{ ok?: boolean; error?: string; label?: string } | undefined>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const ready = fields.every((f) => f.optional || (values[f.name] ?? "").trim());
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await onSubmit(values);
          if (r?.error) toast.error(r.error);
          else {
            setValues({});
            toast.success(`${r?.label ?? "Channel"} connected. Finish the setup steps shown on the card.`);
          }
        });
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className="block space-y-1 text-xs text-muted-foreground">
          {f.label}
          {f.optional ? " (optional)" : ""}
          <Input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            placeholder={f.placeholder}
            className="font-mono"
            disabled={disabled || pending}
          />
        </label>
      ))}
      <Button type="submit" size="sm" disabled={disabled || pending || !ready}>
        <Link2 /> {submitLabel}
      </Button>
    </form>
  );
}

export function WhatsAppConnectForm({ orgSlug, agentSlug, disabled }: { orgSlug: string; agentSlug: string; disabled: boolean }) {
  return (
    <CredentialsForm
      disabled={disabled}
      submitLabel="Connect WhatsApp number"
      fields={[
        { name: "phoneNumberId", label: "Phone number ID", placeholder: "1234567890" },
        { name: "wabaId", label: "WhatsApp Business Account ID", placeholder: "1234567890" },
        { name: "accessToken", label: "System User access token", secret: true },
        { name: "appSecret", label: "App Secret", secret: true },
        { name: "displayNumber", label: "Display number", placeholder: "+1 555 0100", optional: true },
      ]}
      onSubmit={(v) =>
        connectWhatsAppAction(orgSlug, agentSlug, { phoneNumberId: v.phoneNumberId ?? "", wabaId: v.wabaId ?? "", accessToken: v.accessToken ?? "", appSecret: v.appSecret ?? "", displayNumber: v.displayNumber ?? "" })
      }
    />
  );
}

export function SlackConnectForm({ orgSlug, agentSlug, disabled }: { orgSlug: string; agentSlug: string; disabled: boolean }) {
  return (
    <CredentialsForm
      disabled={disabled}
      submitLabel="Connect Slack workspace"
      fields={[
        { name: "botToken", label: "Bot User OAuth Token", placeholder: "xoxb-…", secret: true },
        { name: "signingSecret", label: "Signing Secret", secret: true },
      ]}
      onSubmit={(v) => connectSlackAction(orgSlug, agentSlug, { botToken: v.botToken ?? "", signingSecret: v.signingSecret ?? "" })}
    />
  );
}

export function DiscordConnectForm({ orgSlug, agentSlug, disabled }: { orgSlug: string; agentSlug: string; disabled: boolean }) {
  return (
    <CredentialsForm
      disabled={disabled}
      submitLabel="Connect Discord app"
      fields={[
        { name: "applicationId", label: "Application ID", placeholder: "1234567890123456789" },
        { name: "publicKey", label: "Public Key", placeholder: "64 hex characters" },
        { name: "botToken", label: "Bot token", secret: true },
      ]}
      onSubmit={(v) => connectDiscordAction(orgSlug, agentSlug, { applicationId: v.applicationId ?? "", publicKey: v.publicKey ?? "", botToken: v.botToken ?? "" })}
    />
  );
}
