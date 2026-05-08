"use client";

import { useEffect, useState } from "react";

/**
 * MinGamesPicker — shared "minimum games per row" threshold control.
 *
 * Renders a fixed-step chip group (1 / 3 / 5 / 10 / 20) plus a Custom
 * numeric field so the user can type any positive integer. The chip
 * lights up when the value matches one of the steps; otherwise the
 * value lives in the Custom box and the chips are all deselected.
 *
 * Used by BattlefieldTab, BuildsTab, OpponentsTab, StrategiesTab, and
 * StrategiesTabBuildVs — every analyzer surface that filters rows by
 * sample size goes through this component so the UX is uniform.
 */

const DEFAULT_STEPS: ReadonlyArray<number> = [1, 3, 5, 10, 20];

export interface MinGamesPickerProps {
  value: number;
  onChange: (n: number) => void;
  /** Override the chip steps. Default [1, 3, 5, 10, 20]. */
  steps?: ReadonlyArray<number>;
  /** Hide the "Min games" caption (e.g. when caller renders its own). */
  hideLabel?: boolean;
  /** Append extra layout classes to the outer flex container. */
  className?: string;
}

export function MinGamesPicker({
  value,
  onChange,
  steps = DEFAULT_STEPS,
  hideLabel = false,
  className = "",
}: MinGamesPickerProps) {
  const [customText, setCustomText] = useState<string>(() =>
    steps.includes(value) ? "" : String(value),
  );

  useEffect(() => {
    if (steps.includes(value)) {
      if (customText !== "") setCustomText("");
    } else if (customText !== String(value)) {
      setCustomText(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, steps]);

  const pickStep = (n: number) => {
    setCustomText("");
    onChange(n);
  };

  const handleCustomChange = (next: string) => {
    // Strip non-digits and a leading run of zeros so "007" → "7".
    const digits = next.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    setCustomText(digits);
    if (digits === "") return;
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n) && n >= 1) {
      onChange(n);
    }
  };

  const handleCustomBlur = () => {
    if (customText !== "") return;
    // Empty on blur — snap to the smallest step (usually 1) so the
    // filter is always defined and downstream queries don't fall
    // through to an undefined/NaN threshold.
    const fallback = steps[0] ?? 1;
    onChange(fallback);
  };

  const isCustom = customText !== "";

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {!hideLabel && (
        <span className="text-[11px] uppercase tracking-wider text-text-dim">
          Min games
        </span>
      )}
      <div
        role="radiogroup"
        aria-label="Minimum games preset"
        className="inline-flex overflow-hidden rounded border border-border"
      >
        {steps.map((n) => {
          const active = !isCustom && value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pickStep(n)}
              title={`Show only rows with at least ${n} game${n === 1 ? "" : "s"}`}
              className={`min-h-[32px] min-w-[32px] px-2.5 text-xs tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                active
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated"
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-text-dim">
        <span className="uppercase tracking-wider">Custom</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={customText}
          onChange={(e) => handleCustomChange(e.target.value)}
          onBlur={handleCustomBlur}
          placeholder="—"
          aria-label="Custom minimum games"
          className="min-h-[32px] w-16 rounded border border-border bg-bg-elevated px-2 text-xs tabular-nums text-text outline-none transition placeholder:text-text-dim focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
      </label>
    </div>
  );
}
