"use client";

import { useMemo, useState } from "react";

/**
 * Customisable mirror-MMR range filter for the MMR-bracketed charts.
 *
 * The user picks the maximum |myMmr - oppMmr| they want included in
 * the aggregation. Lower values isolate "matched skill" games (a
 * Cannon Rush that wins 70% becomes much more interesting when
 * you're sure 60% of those wins weren't vs Bronze 5 opponents).
 * "Off" passes the full range through.
 *
 * Presets reflect the ladders most streamers actually queue:
 *   ±50   — mirror-MMR, the bingo-cell "tight game" definition.
 *   ±150  — a typical ladder MMR window.
 *   ±300  — the wider matchmaker net during off-peak hours.
 *   Custom — numeric input for anything else.
 *   Off   — no filter applied.
 *
 * Production-quality contract:
 *   * Stateless: the parent owns ``value`` (undefined = off).
 *   * Stable: the custom input only commits on blur / Enter so
 *     mid-typing doesn't re-key the data fetch on every keystroke.
 *   * Tactile: each preset is its own button with aria-pressed so
 *     screen readers announce selection state.
 *   * Mobile: pills wrap and the custom input scales to width.
 */
export function MmrRangeFilter({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const PRESETS = [
    { id: "off", label: "Off", value: undefined as number | undefined },
    { id: "50", label: "±50", value: 50 },
    { id: "150", label: "±150", value: 150 },
    { id: "300", label: "±300", value: 300 },
  ];

  const presetMatch = PRESETS.find((p) => p.value === value);
  const [customText, setCustomText] = useState<string>(() =>
    value != null && !presetMatch ? String(value) : "",
  );

  const commitCustom = () => {
    const digits = customText.replace(/\D/g, "");
    if (!digits) {
      onChange(undefined);
      setCustomText("");
      return;
    }
    const n = Number.parseInt(digits, 10);
    if (!Number.isFinite(n) || n <= 0) {
      onChange(undefined);
      setCustomText("");
      return;
    }
    // Cap to a sane analyzer range — the backend clamps too, but
    // mirroring it here keeps the UI from accepting then rejecting.
    const clamped = Math.min(n, 5000);
    onChange(clamped);
    setCustomText(String(clamped));
  };

  const customActive = value != null && !presetMatch;
  const labelText = useMemo(() => {
    if (value == null) return "all games";
    return `within ±${value} MMR`;
  }, [value]);

  return (
    <div
      role="group"
      aria-label="Filter games by MMR range between players"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-[11px] uppercase tracking-wider text-text-dim">
        MMR Δ
      </span>
      {PRESETS.map((p) => {
        const active = p.value === value;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              onChange(p.value);
              setCustomText("");
            }}
            aria-pressed={active}
            className={[
              "inline-flex min-h-[28px] items-center rounded-full border px-2 py-0.5",
              "text-[11px] font-medium uppercase tracking-wider tabular-nums",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              active
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border text-text-dim hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            {p.label}
          </button>
        );
      })}
      <label
        className={[
          "inline-flex min-h-[28px] items-center gap-1 rounded-full border px-2 py-0.5",
          "text-[11px] font-medium uppercase tracking-wider",
          "transition-colors focus-within:border-accent/40 focus-within:bg-accent/10",
          customActive
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border text-text-dim",
        ].join(" ")}
        title="Custom MMR window in points"
      >
        <span className="text-[10px]">±</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d*"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          aria-label="Custom MMR delta"
          placeholder="—"
          className="w-12 bg-transparent text-center tabular-nums outline-none placeholder:text-text-dim/60"
        />
      </label>
      <span className="text-[10px] text-text-dim/70" aria-live="polite">
        {labelText}
      </span>
    </div>
  );
}
