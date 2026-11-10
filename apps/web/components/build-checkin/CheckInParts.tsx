"use client";

import Link from "next/link";
import { Dices, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { StrategyLabel } from "@/components/definitions/StrategyLabel";
import {
  STATUS_LABEL,
  buildOptionHref,
  suggestionReasonLabel,
  type BuildIntentStatus,
  type BuildRef,
  type BuildSuggestion,
} from "@/lib/buildIntent";

/** Small building blocks shared by the game page card and the queue. */

const STATUS_VARIANT = {
  none: "neutral",
  pending: "warning",
  confirmed: "success",
  skipped: "neutral",
} as const;

export function CheckInStatusBadge({ status }: { status: BuildIntentStatus }) {
  return (
    <Badge size="sm" variant={STATUS_VARIANT[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Why the build was suggested: "Randomizer roll", "4/5 rules matched", … */
export function ReasonChip({
  suggestion,
  matchup,
}: {
  suggestion: BuildSuggestion;
  matchup?: string | null;
}) {
  const label = suggestionReasonLabel(suggestion, matchup);
  return (
    <Badge
      size="sm"
      variant={suggestion.reason === "randomizer" ? "signal" : "cyan"}
      iconLeft={
        suggestion.reason === "randomizer" ? (
          <Dices className="h-3 w-3" aria-hidden />
        ) : (
          <Sparkles className="h-3 w-3" aria-hidden />
        )
      }
    >
      {label}
    </Badge>
  );
}

/**
 * A planned or suggested build's name: your own builds link to their
 * library page, catalog builds to their definition, anything else is text.
 * `onNavigate` lets a dialog close itself when the link is followed.
 */
export function BuildNameLink({
  build,
  onNavigate,
  className = "font-semibold text-text",
}: {
  /** A build deleted from your library since has no page to open. */
  build: Pick<BuildRef, "key" | "name"> & { deleted?: boolean };
  onNavigate?: () => void;
  className?: string;
}) {
  const href = build.deleted ? null : buildOptionHref(build.key, build.name);
  if (!href) return <span className={className}>{build.name}</span>;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={[
        className,
        "rounded underline decoration-dotted underline-offset-2 hover:text-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      ].join(" ")}
    >
      {build.name}
    </Link>
  );
}

/** "Replay classified as …" — the classifier's own label for the game. */
export function DetectedLine({
  detected,
  executed = false,
  className = "",
  onNavigate,
}: {
  detected: string | null | undefined;
  executed?: boolean;
  className?: string;
  /** Called when the definition link is followed (a dialog closes itself). */
  onNavigate?: () => void;
}) {
  return (
    <p className={["text-caption text-text-muted", className].filter(Boolean).join(" ")}>
      Replay classified as{" "}
      <span className="font-semibold text-text"><StrategyLabel label={detected?.trim() || "Unclassified"} onClick={onNavigate} /></span>
      {executed ? <span className="text-success"> · matches your plan</span> : null}
    </p>
  );
}
