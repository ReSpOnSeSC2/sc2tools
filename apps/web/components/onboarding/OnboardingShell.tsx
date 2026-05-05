"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { OnboardingStepId } from "./types";

const STEPS: ReadonlyArray<{ id: OnboardingStepId; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "download", label: "Download" },
  { id: "pair", label: "Pair" },
];

export interface OnboardingHelpers {
  /** Move forward; clamped to the last step. */
  next: () => void;
  /** Move backward; clamped to the first step. */
  prev: () => void;
  /** Jump to a known step id (used by skip / pair-success transitions). */
  goTo: (id: OnboardingStepId) => void;
  isFirst: boolean;
  isLast: boolean;
  step: OnboardingStepId;
  index: number;
}

export interface OnboardingShellProps {
  initial?: OnboardingStepId;
  /** Called when the wizard wants to leave (Skip / final CTA). */
  onClose: () => void;
  renderStep: (helpers: OnboardingHelpers) => ReactNode;
  /**
   * Optional override for the bottom-left "Back" / "Skip" buttons. By
   * default each step renders its own primary action via `renderStep`,
   * and the shell renders only Back + Skip.
   */
  hideDefaultNav?: boolean;
}

/**
 * 3-step onboarding wizard shell. Owns the step pointer, exposes
 * helpers to children, and renders a sticky bottom action bar that
 * respects iOS `safe-area-inset-bottom`.
 *
 * Responsive behaviour:
 *   - Mobile (≤640): step indicator becomes "Step 2 of 3" + a thin
 *     progress bar so the row never overflows on a 375px viewport.
 *   - Desktop: numbered chips with checkmarks for completed steps.
 *
 * Theme: brand cyan halo — uses the existing `var(--halo-cyan)` token
 * via the `shadow-halo-cyan` utility.
 */
export function OnboardingShell({
  initial = "welcome",
  onClose,
  renderStep,
  hideDefaultNav = false,
}: OnboardingShellProps) {
  const [active, setActive] = useState<OnboardingStepId>(initial);
  const idx = STEPS.findIndex((s) => s.id === active);

  const helpers = useMemo<OnboardingHelpers>(
    () => ({
      next: () => {
        const ni = Math.min(STEPS.length - 1, idx + 1);
        setActive(STEPS[ni].id);
      },
      prev: () => {
        const pi = Math.max(0, idx - 1);
        setActive(STEPS[pi].id);
      },
      goTo: (id) => {
        if (STEPS.some((s) => s.id === id)) setActive(id);
      },
      isFirst: idx === 0,
      isLast: idx === STEPS.length - 1,
      step: active,
      index: idx,
    }),
    [idx, active],
  );

  // Restore focus to the page heading on every step change so screen
  // readers announce the new step content.
  useEffect(() => {
    const heading = document.getElementById("onboarding-step-heading");
    if (heading) heading.focus();
  }, [active]);

  const back = useCallback(() => helpers.prev(), [helpers]);

  return (
    <div className="relative isolate flex min-h-[calc(100svh-4rem)] flex-col">
      <ProgressBar idx={idx} total={STEPS.length} />

      <main className="flex-1 px-4 pb-24 pt-6 sm:px-6 sm:pt-10">
        <div className="mx-auto w-full max-w-2xl">
          <StepIndicatorMobile idx={idx} total={STEPS.length} />
          {renderStep(helpers)}
        </div>
      </main>

      {!hideDefaultNav ? (
        <nav
          aria-label="Onboarding navigation"
          className="sticky bottom-0 z-10 border-t border-border bg-bg-surface/95 px-4 backdrop-blur sm:px-6"
          style={{
            paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            paddingTop: "0.75rem",
          }}
        >
          <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
            <Button
              variant="ghost"
              onClick={back}
              disabled={helpers.isFirst}
              aria-label="Go to previous step"
            >
              ← Back
            </Button>
            <Button
              variant="ghost"
              onClick={onClose}
              aria-label="Skip onboarding for now"
            >
              Skip for now
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function ProgressBar({ idx, total }: { idx: number; total: number }) {
  const pct = ((idx + 1) / total) * 100;
  return (
    <div
      className="h-0.5 w-full overflow-hidden bg-bg-elevated"
      role="progressbar"
      aria-valuenow={idx + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${idx + 1} of ${total}`}
    >
      <div
        className="h-full bg-accent-cyan shadow-halo-cyan transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StepIndicatorMobile({ idx, total }: { idx: number; total: number }) {
  return (
    <div
      className="mb-6 flex items-center gap-3"
      role="presentation"
      aria-hidden="true"
    >
      {STEPS.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <span
              className={[
                "inline-flex h-7 w-7 items-center justify-center rounded-full border text-caption font-semibold transition-colors",
                current
                  ? "border-accent-cyan bg-accent-cyan/15 text-accent-cyan shadow-halo-cyan"
                  : done
                    ? "border-success/60 bg-success/10 text-success"
                    : "border-border bg-bg-subtle text-text-dim",
              ].join(" ")}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
            </span>
            <span
              className={[
                "hidden text-caption font-medium sm:inline",
                current
                  ? "text-text"
                  : done
                    ? "text-text-muted"
                    : "text-text-dim",
              ].join(" ")}
            >
              {s.label}
            </span>
            {i < total - 1 ? (
              <span
                className={[
                  "h-px w-6 sm:w-10",
                  i < idx ? "bg-success/60" : "bg-border",
                ].join(" ")}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
