import { ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type VerificationView = {
  status: "verified" | "failed" | "unavailable" | "not_requested" | "no_inference";
  method?: "router" | "independent";
  reason?: string | null;
  signerAddress?: string | null;
};

const CORRECTNESS = "Verification doesn't mean the answer is correct.";

function describe(v: VerificationView): { label: string; detail: string; className: string; Icon: typeof ShieldCheck } {
  switch (v.status) {
    case "verified":
      return v.method === "independent"
        ? {
            label: "TEE signature verified",
            detail: `Alactic checked this response's signature itself, against the provider's TEE signer registered on 0G Chain${
              v.signerAddress ? ` (${v.signerAddress.slice(0, 6)}…${v.signerAddress.slice(-4)})` : ""
            }. The signature covers the encrypted exchange for this chat, not a match of these exact words. ${CORRECTNESS}`,
            className: "border-success/40 text-success",
            Icon: ShieldCheck,
          }
        : {
            label: "TEE signature verified (Router)",
            detail: `The 0G Router reported that the provider's TEE signature verified. ${CORRECTNESS}`,
            className: "border-success/40 text-success",
            Icon: ShieldCheck,
          };
    case "failed":
      return {
        label: "Verification failed",
        detail: `${v.reason ?? "The signature didn't verify."} The response was treated as untrusted and withheld.`,
        className: "border-destructive/40 text-destructive",
        Icon: ShieldAlert,
      };
    case "unavailable":
      return {
        label: "Verification unavailable",
        detail: v.reason ?? "Verification was requested, but no verification result could be obtained for this response.",
        className: "border-warning/50 text-warning",
        Icon: ShieldQuestion,
      };
    case "not_requested":
      return { label: "Not verified (Standard mode)", detail: "Standard mode has no attestation, so responses can't be verified.", className: "text-muted-foreground", Icon: ShieldOff };
    default:
      return {
        label: "No AI response",
        detail: "The AI request didn't complete, so there is nothing to verify. The agent's fallback answer was shown.",
        className: "text-muted-foreground",
        Icon: ShieldOff,
      };
  }
}

export function VerificationBadge({ verification }: { verification: VerificationView }) {
  const { label, detail, className, Icon } = describe(verification);
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" className={`gap-1 ${className}`} />}>
        <Icon className="size-3" aria-hidden /> {label}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{detail}</TooltipContent>
    </Tooltip>
  );
}
