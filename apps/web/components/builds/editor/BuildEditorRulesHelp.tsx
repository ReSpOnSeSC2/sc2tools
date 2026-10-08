"use client";

import { Fragment } from "react";
import { ChevronDown, CircleHelp, TriangleAlert } from "lucide-react";
import { RULES_LEGEND, RULES_LEGEND_FOOTER } from "@/lib/build-rules-copy";
import type { NameCountWarning } from "@/lib/build-rules-name-check";

const CALLOUT_CLASSES =
  "flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-caption text-warning";

/**
 * "How rules count" — the rules vocabulary as a native <details>,
 * collapsed by default. The terms are the editor's own words (At least
 * 2, Exactly 2, At most 2, None, before 4:20, Only count proxied).
 */
export function RulesLegend() {
  return (
    <details className="group rounded-lg border border-border bg-bg-subtle/30 px-3 text-caption">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-3.5 w-3.5" aria-hidden />
        How rules count
        <ChevronDown
          className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 pb-2 pt-1 text-micro sm:grid-cols-[auto_1fr]">
        {RULES_LEGEND.map(({ term, detail }) => (
          <Fragment key={term}>
            <dt className="font-semibold text-text">{term}</dt>
            <dd className="text-text-muted">{detail}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="pb-3 text-micro text-text-dim">{RULES_LEGEND_FOOTER}</p>
    </details>
  );
}

/**
 * Shown when every named rule only caps or forbids (rulesRequireNothing),
 * so a game with none of it built still matches. Advisory only.
 */
export function RequireNothingCallout() {
  return (
    <p role="status" className={CALLOUT_CLASSES}>
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Every rule here also passes when none of it is built, so this build
        could match almost any game. Add an “At least” or “Exactly” rule for
        something the build must have.
      </span>
    </p>
  );
}

interface NameCountCalloutProps {
  warning: NameCountWarning;
  /** Applies the raise; only called for the "raise" kind. */
  onRequire: () => void;
  /** Hides this token and number for the rest of the modal session. */
  onDismiss: () => void;
}

/**
 * The build name says "2 Stargate" but the rules pass with fewer. The
 * "Require N" button (raise kind only) makes the same change as the
 * timeline's "At least N" chip. Advisory only; never blocks saving.
 */
export function NameCountCallout({
  warning,
  onRequire,
  onDismiss,
}: NameCountCalloutProps) {
  return (
    <div role="status" className={CALLOUT_CLASSES}>
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0">{warning.text}</span>
        {warning.kind === "raise" ? (
          <button
            type="button"
            onClick={onRequire}
            className="inline-flex min-h-8 items-center rounded-md border border-warning/50 bg-warning/15 px-2 text-micro font-semibold text-warning transition-colors hover:bg-warning/25"
          >
            Require {warning.n}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this name check"
          className="inline-flex min-h-8 items-center px-1 text-micro font-medium text-warning underline underline-offset-2 hover:text-text"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
