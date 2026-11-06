"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Cpu, Loader2, Lock, ShieldCheck } from "lucide-react";
import { saveAgentAction, type AgentFormState } from "@/app/dashboard/[orgSlug]/agents/actions";
import { Field, selectClassName } from "@/components/agents/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  LANGUAGES,
  LIMITS,
  TONES,
  TRUST_MODE_INFO,
  TRUST_MODES,
  type TrustModeOption,
} from "@/lib/agent-options";
import { cn } from "@/lib/utils";

export type BuilderConfig = {
  name: string;
  description: string;
  instructions: string;
  persona: string;
  tone: string;
  language: string;
  fallbackMessage: string;
  modelId: string;
  trustMode: TrustModeOption;
  temperature: number;
  maxOutputTokens: number;
  retrievalTopK: number;
  updatedAt: string;
};

export type BuilderModel = {
  id: string;
  name: string;
  verifiability: "TeeML" | "TeeTLS" | null;
  contextLength: number | null;
  pricingUsd: { prompt: string | null; completion: string | null };
  trustModes: TrustModeOption[];
};

export type BuilderCatalog =
  | { ok: true; models: BuilderModel[]; availability: Record<string, Record<TrustModeOption, boolean>>; staleSince?: string }
  | { ok: false; error: string };

const TRUST_ICONS = { private: Lock, verified: ShieldCheck, standard: Cpu } as const;

function perMillion(price: string | null) {
  if (!price) return null;
  const n = Number(price) * 1_000_000;
  return Number.isFinite(n) ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : null;
}

export function AgentBuilderForm({
  orgSlug,
  agentSlug,
  config,
  catalog,
  canEdit,
  slugLocked,
  ensParent,
}: {
  orgSlug: string;
  agentSlug: string;
  config: BuilderConfig;
  catalog: BuilderCatalog;
  canEdit: boolean;
  slugLocked: boolean;
  ensParent: string;
}) {
  const [state, action, pending] = useActionState<AgentFormState, FormData>(
    saveAgentAction.bind(null, orgSlug, agentSlug),
    undefined,
  );
  const [modelId, setModelId] = useState(config.modelId);
  const [trustMode, setTrustMode] = useState<TrustModeOption>(config.trustMode);
  const [slug, setSlug] = useState(agentSlug);
  const [instructionsLength, setInstructionsLength] = useState(config.instructions.length);
  const fe = state?.fieldErrors ?? {};
  const expectedUpdatedAt = state?.updatedAt ?? config.updatedAt;

  const models = catalog.ok ? catalog.models : [];
  const selectedModel = models.find((m) => m.id === modelId);
  const modelKnown = !catalog.ok || !!selectedModel;
  const trustSupported = selectedModel ? selectedModel.trustModes.includes(trustMode) : !catalog.ok;
  const availability = catalog.ok ? catalog.availability[modelId] : undefined;
  const modelLocked = !catalog.ok || !canEdit;

  const groups = {
    tee: models.filter((m) => m.verifiability !== null),
    standard: models.filter((m) => m.verifiability === null),
  };

  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <input type="hidden" name="modelId" value={modelId} />
      <input type="hidden" name="trustMode" value={trustMode} />

      <fieldset disabled={!canEdit || pending} className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>How the agent introduces itself. Name and description are public.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field id="name" label="Name" error={fe.name}>
              <Input id="name" name="name" required minLength={2} maxLength={LIMITS.name.max} defaultValue={config.name} aria-invalid={!!fe.name} />
            </Field>
            <Field id="description" label="Description" error={fe.description} hint="Public. Shown on the chat page and in the agent's public identity.">
              <Textarea id="description" name="description" rows={2} maxLength={LIMITS.description.max} defaultValue={config.description} />
            </Field>
            <Field
              id="slug"
              label="Agent URL"
              error={fe.slug}
              hint={
                slugLocked ? (
                  "Locked: this agent has been published, and the URL is its public address."
                ) : (
                  <>
                    Planned ENS name: <span className="font-mono">{slug}.{ensParent}</span> (not published yet).
                  </>
                )
              }
            >
              {slugLocked ? (
                <Input id="slug" value={agentSlug} readOnly disabled className="font-mono" />
              ) : (
                <Input
                  id="slug"
                  name="slug"
                  required
                  className="font-mono"
                  pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
                  value={slug}
                  aria-invalid={!!fe.slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                />
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Behavior</CardTitle>
            <CardDescription>
              Private to your organization. Never published. Alactic&apos;s safety policy always takes precedence over these
              instructions.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field
              id="instructions"
              label="Instructions"
              error={fe.instructions}
              aside={
                <span className="text-xs text-muted-foreground tabular-nums">
                  {instructionsLength.toLocaleString()} / {LIMITS.instructions.max.toLocaleString()}
                </span>
              }
              hint="What the agent should help with, what it must not do, and when to hand off to a human. Don't put secrets here."
            >
              <Textarea
                id="instructions"
                name="instructions"
                rows={8}
                maxLength={LIMITS.instructions.max}
                defaultValue={config.instructions}
                onChange={(e) => setInstructionsLength(e.target.value.length)}
                placeholder={"You help customers of Acme with orders, shipping and returns.\nIf a question is about billing disputes, ask them to email billing@acme.com."}
              />
            </Field>
            <Field id="persona" label="Personality" error={fe.persona} hint="Optional. A short description of the agent's voice.">
              <Input id="persona" name="persona" maxLength={LIMITS.persona.max} defaultValue={config.persona} placeholder="A calm, knowledgeable product specialist" />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="tone" label="Tone" error={fe.tone}>
                <select id="tone" name="tone" defaultValue={config.tone} className={selectClassName}>
                  {TONES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}: {t.hint}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="language" label="Language" error={fe.language}>
                <select id="language" name="language" defaultValue={config.language} className={selectClassName}>
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              id="fallbackMessage"
              label="Fallback answer"
              error={fe.fallbackMessage}
              hint="Used when the agent can't find an answer in your knowledge, or when AI inference is unavailable."
            >
              <Textarea
                id="fallbackMessage"
                name="fallbackMessage"
                rows={2}
                required
                minLength={LIMITS.fallback.min}
                maxLength={LIMITS.fallback.max}
                defaultValue={config.fallbackMessage}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model &amp; trust</CardTitle>
            <CardDescription>
              Inference runs on the 0G Compute Network. The trust mode you choose is enforced on every request. If it&apos;s
              unavailable, the agent shows its fallback answer instead of quietly using a less private mode.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {catalog.ok && catalog.staleSince ? (
              <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                The 0G model catalog is slow to respond right now. Showing the list last fetched from 0G; provider health isn&apos;t shown.
              </p>
            ) : null}
            {!catalog.ok ? (
              <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {catalog.error}
              </p>
            ) : null}
            <Field
              id="model"
              label="Model"
              error={fe.modelId ?? (!modelKnown ? "This model is no longer listed by the 0G Router. Choose another." : undefined)}
              hint={
                selectedModel ? (
                  <span className="flex flex-wrap gap-x-3">
                    <span>{selectedModel.verifiability ? `${selectedModel.verifiability} (TEE)` : "No TEE attestation"}</span>
                    {selectedModel.contextLength ? <span>{selectedModel.contextLength.toLocaleString()} token context</span> : null}
                    {perMillion(selectedModel.pricingUsd.prompt) ? (
                      <span>
                        {perMillion(selectedModel.pricingUsd.prompt)} in / {perMillion(selectedModel.pricingUsd.completion)} out per 1M tokens
                      </span>
                    ) : null}
                  </span>
                ) : undefined
              }
            >
              <select
                id="model"
                value={modelId}
                disabled={modelLocked}
                onChange={(e) => setModelId(e.target.value)}
                className={selectClassName}
              >
                {!modelKnown || !catalog.ok ? <option value={config.modelId}>{config.modelId}</option> : null}
                {groups.tee.length ? (
                  <optgroup label="TEE-capable: Private / Verified">
                    {groups.tee.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} · {m.verifiability}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {groups.standard.length ? (
                  <optgroup label="Standard only (not verifiable)">
                    {groups.standard.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </Field>

            <div role="radiogroup" aria-label="Trust mode" className="grid gap-3">
              {TRUST_MODES.map((mode) => {
                const Icon = TRUST_ICONS[mode];
                const supported = selectedModel ? selectedModel.trustModes.includes(mode) : mode === config.trustMode;
                const live = availability?.[mode];
                const selected = trustMode === mode;
                return (
                  <label
                    key={mode}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                      selected ? "border-foreground/40 bg-muted/50" : "hover:bg-muted/30",
                      (!supported || modelLocked) && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="trustModeChoice"
                      value={mode}
                      checked={selected}
                      disabled={!supported || modelLocked}
                      onChange={() => setTrustMode(mode)}
                      className="mt-1 accent-foreground"
                    />
                    <span className="grid flex-1 gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Icon className="size-4 text-brand" aria-hidden />
                        <span className="font-medium">{TRUST_MODE_INFO[mode].label}</span>
                        {mode === "private" ? <Badge variant="outline">Recommended</Badge> : null}
                        {!supported ? (
                          <Badge variant="secondary">Not supported by this model</Badge>
                        ) : live === true ? (
                          <Badge variant="outline" className="gap-1 border-success/40 text-success">
                            <CheckCircle2 className="size-3" aria-hidden /> Healthy provider now
                          </Badge>
                        ) : live === false ? (
                          <Badge variant="outline" className="gap-1 border-warning/50 text-warning">
                            <AlertTriangle className="size-3" aria-hidden /> No healthy provider right now
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 text-muted-foreground">
                            <CircleHelp className="size-3" aria-hidden /> Checked at request time
                          </Badge>
                        )}
                      </span>
                      <span className="text-sm text-muted-foreground">{TRUST_MODE_INFO[mode].summary}</span>
                      {selected ? <span className="text-xs text-muted-foreground">{TRUST_MODE_INFO[mode].detail}</span> : null}
                    </span>
                  </label>
                );
              })}
              {!trustSupported && catalog.ok ? (
                <p role="alert" className="text-sm text-destructive">
                  {modelId} can&apos;t run in {TRUST_MODE_INFO[trustMode].label} mode. Pick a supported mode or a TEE-capable model.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Provider health is a snapshot from the 0G Router, refreshed every few minutes. TEE verification shows where a
                response was computed, not that it is correct.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Advanced</CardTitle>
            <CardDescription>Defaults suit most support agents.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-3">
            <Field id="temperature" label="Temperature" error={fe.temperature} hint="0 = consistent, 1 = varied.">
              <Input id="temperature" name="temperature" type="number" step="0.1" min={0} max={1} defaultValue={config.temperature} />
            </Field>
            <Field id="maxOutputTokens" label="Max answer length" error={fe.maxOutputTokens} hint="Tokens (128–4096).">
              <Input id="maxOutputTokens" name="maxOutputTokens" type="number" step="1" min={128} max={4096} defaultValue={config.maxOutputTokens} />
            </Field>
            <Field id="retrievalTopK" label="Sources per answer" error={fe.retrievalTopK} hint="Knowledge passages retrieved (1–20).">
              <Input id="retrievalTopK" name="retrievalTopK" type="number" step="1" min={1} max={20} defaultValue={config.retrievalTopK} />
            </Field>
          </CardContent>
        </Card>
      </fieldset>

      {canEdit ? (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t bg-background/90 px-1 py-3 backdrop-blur">
          <div className="text-sm" aria-live="polite">
            {state?.error ? (
              <span className="text-destructive">{state.error}</span>
            ) : state?.ok ? (
              <span className="text-success">Draft saved.</span>
            ) : (
              <span className="text-muted-foreground">Changes are saved to the draft. Publish them from the Deploy tab.</span>
            )}
          </div>
          <Button type="submit" disabled={pending || (catalog.ok && (!trustSupported || !modelKnown))}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save draft
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">You have view-only access. Owners and admins can edit agents.</p>
      )}
    </form>
  );
}
