"use client";

import { Dices, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import {
  STATUS_LABEL,
  suggestionReasonLabel,
  type BuildIntentStatus,
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

/** "Replay classified as …" — the classifier's own label for the game. */
export function DetectedLine({
  detected,
  executed = false,
  className = "",
}: {
  detected: string | null | undefined;
  executed?: boolean;
  className?: string;
}) {
  return (
    <p className={["text-caption text-text-muted", className].filter(Boolean).join(" ")}>
      Replay classified as{" "}
      <span className="font-semibold text-text">{detected?.trim() || "Unclassified"}</span>
      {executed ? <span className="text-success"> · matches your plan</span> : null}
    </p>
  );
}
