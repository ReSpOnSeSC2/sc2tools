"use client";

import { User, Users } from "lucide-react";
import type { BuildPerspective } from "./BuildOrderTimeline.types";

/**
 * BuildOrderPerspectiveToggle — segmented "You" / "Opponent" control.
 *
 * Disabled state: when the parent has no opponent events the
 * "Opponent" segment is not selectable. We keep both buttons rendered
 * for layout stability and surface the reason in `aria-disabled`.
 */
export interface BuildOrderPerspectiveToggleProps {
  value: BuildPerspective;
  onChange: (next: BuildPerspective) => void;
  /** When false, the "Opponent" segment is shown but disabled. */
  opponentAvailable: boolean;
  /** Optional hint text rendered into the disabled tooltip / aria-disabled. */
  opponentDisabledReason?: string;
  className?: string;
}

const SEGMENT_BASE =
  "inline-flex items-center justify-center gap-1.5 h-9 min-h-[36px] sm:h-9 px-3 text-caption font-semibold rounded-md transition-colors min-w-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function BuildOrderPerspectiveToggle({
  value,
  onChange,
  opponentAvailable,
  opponentDisabledReason,
  className = "",
}: BuildOrderPerspectiveToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Build perspective"
      className={[
        "inline-flex items-center gap-1 rounded-lg border border-border bg-bg-elevated p-0.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === "you"}
        onClick={() => onChange("you")}
        className={[
          SEGMENT_BASE,
          value === "you"
            ? "bg-accent text-white"
            : "text-text-muted hover:text-text",
        ].join(" ")}
      >
        <User className="h-4 w-4" aria-hidden />
        You
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "opponent"}
        aria-disabled={!opponentAvailable || undefined}
        disabled={!opponentAvailable}
        onClick={() => onChange("opponent")}
        title={
          opponentAvailable
            ? undefined
            : (opponentDisabledReason ??
              "Opponent build not extracted for this game yet")
        }
        className={[
          SEGMENT_BASE,
          value === "opponent" && opponentAvailable
            ? "bg-accent text-white"
            : "text-text-muted hover:text-text",
          !opponentAvailable ? "cursor-not-allowed opacity-50" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Users className="h-4 w-4" aria-hidden />
        Opponent
      </button>
    </div>
  );
}
