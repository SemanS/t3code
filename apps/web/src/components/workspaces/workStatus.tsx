/** How a thread's or agent's state reads across Peer's work views. */
import type { PeerWorkStatus } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

export const STATUS_LABEL: Readonly<Record<PeerWorkStatus, string>> = {
  working: "Working",
  blocked: "Needs input",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown",
};

// The hues the Threads list uses: sky while working, amber while it waits on
// someone. Finished work recedes, since most threads end up there.
export const STATUS_ICON: Readonly<Record<PeerWorkStatus, LucideIcon>> = {
  working: CircleDashedIcon,
  blocked: MessageCircleQuestionIcon,
  done: CircleCheckIcon,
  idle: CircleIcon,
  unknown: CircleIcon,
};
export const STATUS_TONE: Readonly<Record<PeerWorkStatus, string>> = {
  working: "text-info",
  blocked: "text-warning-foreground",
  done: "text-muted-foreground",
  idle: "text-muted-foreground/60",
  unknown: "text-muted-foreground/60",
};

export function StatusGlyph({
  status,
  stale = false,
}: {
  readonly status: PeerWorkStatus;
  readonly stale?: boolean;
}) {
  const Icon = STATUS_ICON[status];
  const quiet = status === "idle" || status === "unknown";
  return (
    <span
      role="img"
      aria-label={stale ? `${STATUS_LABEL[status]} (not reported lately)` : STATUS_LABEL[status]}
      className={cn("flex size-3.5 shrink-0 items-center justify-center", stale && "opacity-50")}
    >
      <Icon aria-hidden className={cn(quiet ? "size-2.5" : "size-3.5", STATUS_TONE[status])} />
    </span>
  );
}

export function StatusIcon({ status }: { readonly status: PeerWorkStatus }) {
  const Icon = STATUS_ICON[status];
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}
