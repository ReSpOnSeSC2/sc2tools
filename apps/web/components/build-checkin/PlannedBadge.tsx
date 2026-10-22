"use client";

import { ClipboardCheck } from "lucide-react";
import { Badge, type BadgeSize } from "@/components/ui/Badge";
import { plannedTooltip } from "@/lib/buildIntent";

/**
 * "Planned" marker for a game whose build label comes from a confirmed
 * check-in rather than the replay classifier. The tooltip (and the
 * screen-reader text) names what the replay itself was classified as.
 */
export function PlannedBadge({
  detected,
  size = "sm",
  className = "",
}: {
  detected?: string | null;
  size?: BadgeSize;
  className?: string;
}) {
  const tooltip = plannedTooltip(detected);
  return (
    <Badge
      size={size}
      variant="neutral"
      title={tooltip}
      iconLeft={<ClipboardCheck className="h-3 w-3" aria-hidden />}
      className={["shrink-0 cursor-help", className].filter(Boolean).join(" ")}
      data-testid="planned-badge"
    >
      Planned
      <span className="sr-only">{`. ${tooltip}`}</span>
    </Badge>
  );
}

/**
 * The build label a game list shows for the player ("The build I played"),
 * followed by the "Planned" marker when a check-in overrides it.
 */
export function PlayedBuildBadge({
  name,
  planned = false,
  detected = null,
}: {
  name: string | null;
  planned?: boolean;
  detected?: string | null;
}) {
  if (!name) return <span className="text-text-dim">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge size="sm" variant="neutral" title={`The build I played: ${name}`}>
        {name}
      </Badge>
      {planned ? <PlannedBadge detected={detected} /> : null}
    </span>
  );
}
