import { Cpu, Lock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TRUST_MODE_INFO, type TrustModeOption } from "@/lib/agent-options";

const ICONS = { private: Lock, verified: ShieldCheck, standard: Cpu } as const;

export function TrustBadge({ mode }: { mode: TrustModeOption }) {
  const Icon = ICONS[mode];
  return (
    <Badge variant="outline" className="gap-1">
      <Icon className="size-3" aria-hidden /> {TRUST_MODE_INFO[mode].label}
    </Badge>
  );
}

export function AgentStatusBadge({ status, hasUnpublishedChanges }: { status: string; hasUnpublishedChanges?: boolean }) {
  if (status === "published") {
    return <Badge variant="default">{hasUnpublishedChanges ? "Published · unpublished changes" : "Published"}</Badge>;
  }
  return (
    <Badge variant="secondary" className="capitalize">
      {status}
    </Badge>
  );
}
