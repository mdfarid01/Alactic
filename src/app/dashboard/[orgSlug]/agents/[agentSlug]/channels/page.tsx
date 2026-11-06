import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertTriangle, Hash, Headphones, MessageCircle, Send, Swords } from "lucide-react";
import { ConnectionActions, DiscordConnectForm, SlackConnectForm, TelegramConnectForm, WhatsAppConnectForm } from "@/components/agents/channel-controls";
import { CopyField } from "@/components/agents/deploy-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { discordInstallUrl, type DiscordCredentials } from "@/server/connectors/discord";
import { connectorKey, connectorsConfigured } from "@/server/connectors/registry";
import { listConnections, loadConnection, type ConnectionView } from "@/server/connectors/service";
import { slackManifest } from "@/server/connectors/slack";
import type { WhatsAppCredentials } from "@/server/connectors/whatsapp";
import { db } from "@/server/db/client";
import type { ConnectorPlatform } from "@/server/db/schema";
import { appOrigin } from "@/server/env";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Channels" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/channels">["params"];

const PLATFORMS: { id: ConnectorPlatform; name: string; Icon: typeof Send; blurb: string }[] = [
  { id: "telegram", name: "Telegram", Icon: Send, blurb: "Your own Telegram bot. Text, voice notes and photos." },
  { id: "whatsapp", name: "WhatsApp", Icon: MessageCircle, blurb: "Your WhatsApp Business number (Cloud API). Text, voice notes and images." },
  { id: "slack", name: "Slack", Icon: Hash, blurb: "@mentions in channels (answered in threads) and DMs, with files." },
  { id: "discord", name: "Discord", Icon: Swords, blurb: "/ask command and the “Ask Alactic” message action, with attachments." },
  { id: "zendesk", name: "Zendesk", Icon: Headphones, blurb: "Answers new tickets as public comments." },
];

export default function ChannelsPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
      <Channels params={params} />
    </Suspense>
  );
}

async function Channels({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const data = await getAgentForEdit(db(), scope, agentSlug);
  if (!data) notFound();
  const connections = await listConnections(db(), scope, agentSlug);
  const canEdit = roleAtLeast(scope.role, "admin");
  const configured = connectorsConfigured();
  const origin = appOrigin();
  const isPublic = origin.protocol === "https:";
  const disabled = !canEdit || !configured;
  const ctx = { orgSlug: scope.orgSlug, agentSlug, canEdit, origin: origin.origin, agentName: data.config.name };
  const setups = new Map(canEdit ? await Promise.all(connections.map(async (c) => [c.id, await setupFor(c, origin.origin)] as const)) : []);

  return (
    <div className="space-y-6">
      {data.agent.status !== "published" ? (
        <Notice tone="warning">Channels answer with the published version. Publish this agent (Deploy tab) before customers can use it on other platforms.</Notice>
      ) : null}
      {!configured ? <Notice tone="error">Channels aren&apos;t configured on this server: set CONNECTOR_ENCRYPTION_KEY to store platform credentials.</Notice> : null}
      {!isPublic ? (
        <Notice tone="warning">
          This server runs on {origin.origin}, which platforms can&apos;t reach. WhatsApp, Slack and Discord need a public HTTPS URL (deploy Alactic or use a tunnel and set
          APP_URL). Telegram works locally with <code className="font-mono">pnpm connectors:poll</code>.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {PLATFORMS.map((p) => {
          const mine = connections.filter((c) => c.platform === p.id);
          return (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  <span className="flex items-center gap-2">
                    <p.Icon className="size-4" /> {p.name}
                  </span>
                  {p.id === "zendesk" ? <Badge variant="secondary">Not available yet</Badge> : mine.length ? <Badge>Connected</Badge> : null}
                </CardTitle>
                <CardDescription>{p.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {mine.map((c) => (
                  <ConnectionRow key={c.id} c={c} {...ctx} setup={setups.get(c.id) ?? null} />
                ))}
                {mine.length === 0 ? <ConnectSection platform={p.id} {...ctx} disabled={disabled} /> : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <p className={`flex gap-2 rounded-lg border p-3 text-sm ${tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-warning/40 bg-warning/10"}`}>
      <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${tone === "error" ? "text-destructive" : "text-warning"}`} />
      <span>{children}</span>
    </p>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  );
}

function ConnectSection({ platform, orgSlug, agentSlug, disabled, agentName }: { platform: ConnectorPlatform; orgSlug: string; agentSlug: string; disabled: boolean; agentName: string }) {
  switch (platform) {
    case "telegram":
      return (
        <>
          <Steps items={["In Telegram, open @BotFather and send /newbot.", "Copy the token it gives you and paste it below."]} />
          <TelegramConnectForm orgSlug={orgSlug} agentSlug={agentSlug} disabled={disabled} />
        </>
      );
    case "whatsapp":
      return (
        <>
          <Steps
            items={[
              "Create a Business app at developers.facebook.com/apps and add the WhatsApp product (a free test number is included).",
              "From WhatsApp → API Setup, copy the Phone number ID and WhatsApp Business Account ID.",
              "In Business Settings → System users, generate a token with whatsapp_business_messaging and whatsapp_business_management.",
              "Copy the App Secret (App settings → Basic). After connecting we show the webhook URL and verify token.",
            ]}
          />
          <WhatsAppConnectForm orgSlug={orgSlug} agentSlug={agentSlug} disabled={disabled} />
        </>
      );
    case "slack":
      return (
        <>
          <Steps
            items={[
              <>
                Go to <span className="font-mono">api.slack.com/apps</span> → Create New App → From a manifest, pick your workspace and paste:
              </>,
              "Install it to your workspace, then copy the Bot User OAuth Token (xoxb-…) and the Signing Secret (Basic Information).",
              "Paste them below. We then show the Events URL to add.",
            ]}
          />
          <CopyField value={JSON.stringify(slackManifest(agentName), null, 2)} label="Slack app manifest" multiline />
          <SlackConnectForm orgSlug={orgSlug} agentSlug={agentSlug} disabled={disabled} />
        </>
      );
    case "discord":
      return (
        <>
          <Steps
            items={[
              "At discord.com/developers/applications, create a New Application.",
              "Copy the Application ID and Public Key (General Information), and the bot token (Bot → Reset Token). Leave privileged intents off.",
              "Paste them below. We register the /ask command and show the Interactions URL and install link.",
            ]}
          />
          <DiscordConnectForm orgSlug={orgSlug} agentSlug={agentSlug} disabled={disabled} />
        </>
      );
    case "zendesk":
      return (
        <p className="text-xs text-muted-foreground">
          Zendesk is retiring API tokens (they stop working on 2027-04-30), and its terms require products like Alactic to use a Zendesk-approved global OAuth client.
          This connector will ship once that approval is in place.
        </p>
      );
  }
}

type Setup = { rows: { label: string; value: string }[]; steps: ReactNode[]; waiting?: string };

async function setupFor(c: ConnectionView, origin: string): Promise<Setup | null> {
  switch (c.platform) {
    case "whatsapp": {
      const conn = await loadConnection<WhatsAppCredentials>(db(), c.id, connectorKey(), "whatsapp");
      return {
        rows: [
          { label: "Callback URL", value: `${origin}/api/connectors/whatsapp/${c.id}` },
          { label: "Verify token", value: conn?.credentials.verifyToken ?? "unavailable" },
        ],
        steps: ["In WhatsApp → Configuration, paste the Callback URL and Verify token, then click Verify and save.", "Subscribe to the messages webhook field."],
        waiting: c.lastEventAt ? undefined : "Waiting for Meta to verify the webhook.",
      };
    }
    case "slack":
      return {
        rows: [{ label: "Events Request URL", value: `${origin}/api/connectors/slack/${c.id}/events` }],
        steps: [
          "In your Slack app → Event Subscriptions, turn events on and paste the Request URL (Slack verifies it).",
          "Under Subscribe to bot events add app_mention and message.im, save, and reinstall the app if asked.",
          "Invite the bot to channels where it should answer: /invite @YourBot.",
        ],
        waiting: c.lastEventAt ? undefined : "Waiting for Slack to verify the Request URL.",
      };
    case "discord": {
      const conn = await loadConnection<DiscordCredentials>(db(), c.id, connectorKey(), "discord");
      return {
        rows: [
          { label: "Interactions Endpoint URL", value: `${origin}/api/connectors/discord/${c.id}/interactions` },
          ...(conn ? [{ label: "Install link", value: discordInstallUrl(conn.credentials.applicationId) }] : []),
        ],
        steps: ["In General Information, paste the Interactions Endpoint URL and save (Discord checks it).", "Open the install link to add the bot to your server, then type /ask."],
        waiting: c.lastEventAt ? undefined : "Waiting for Discord to verify the endpoint.",
      };
    }
    default:
      return null;
  }
}

function ConnectionRow({ c, orgSlug, agentSlug, canEdit, setup }: { c: ConnectionView; orgSlug: string; agentSlug: string; canEdit: boolean; setup: Setup | null }) {
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {c.label}
          <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
          {c.deliveryMode === "polling" ? <Badge variant="outline">local polling</Badge> : null}
        </span>
        <ConnectionActions orgSlug={orgSlug} agentSlug={agentSlug} connectionId={c.id} status={c.status} canEdit={canEdit} />
      </div>
      <p className="text-xs text-muted-foreground">
        {c.lastEventAt ? `Last activity ${c.lastEventAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : "No activity yet"}
      </p>
      {c.deliveryMode === "polling" ? (
        <p className="text-xs text-muted-foreground">
          No public HTTPS URL, so Telegram can&apos;t send webhooks. Run <code className="font-mono">pnpm connectors:poll</code> to receive messages locally.
        </p>
      ) : null}
      {setup ? (
        <div className="space-y-2">
          {setup.waiting ? <p className="text-xs text-warning">{setup.waiting}</p> : null}
          <Steps items={setup.steps} />
          {setup.rows.map((r) => (
            <div key={r.label} className="space-y-1">
              <p className="text-xs text-muted-foreground">{r.label}</p>
              <CopyField value={r.value} label={r.label} />
            </div>
          ))}
        </div>
      ) : null}
      {c.lastError ? <p className="text-xs text-destructive">{c.lastError}</p> : null}
    </div>
  );
}
