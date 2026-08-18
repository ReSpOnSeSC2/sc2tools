"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  MAX_GAME_LENGTH_MINUTES,
  normalizeGameLengthBounds,
  useFilters,
} from "@/lib/filterContext";
import { PillButton } from "./FilterPill";

/**
 * Quick game-length bands offered beside the custom range.
 *
 * The edges sit on Macro Report bucket boundaries (10 and 20 minutes)
 * so a band composes with that tab's segments instead of cutting across
 * them. Lower bound inclusive, upper bound EXCLUSIVE — the bands tile,
 * and a game that ended at exactly 20:00 appears in "20+" only.
 */
const LENGTH_BANDS: ReadonlyArray<{
  id: string;
  label: string;
  title: string;
  min?: number;
  max?: number;
}> = [
  { id: "short", label: "< 10", title: "Games under 10 minutes", max: 10 },
  {
    id: "mid",
    label: "10–20",
    title: "Games from 10 up to 20 minutes",
    min: 10,
    max: 20,
  },
  { id: "long", label: "20+", title: "Games of 20 minutes or longer", min: 20 },
];

/** Human label for a bound pair, e.g. "7–13 min" / "20+ min" / "< 8 min". */
function lengthRangeLabel(min?: number, max?: number): string | null {
  if (min !== undefined && max !== undefined) return `${min}–${max} min`;
  if (min !== undefined) return `${min}+ min`;
  if (max !== undefined) return `< ${max} min`;
  return null;
}

/**
 * Global "Game length" filter. Bounds are whole minutes and drive every
 * analyzer tab through the shared filter context, the same way Region /
 * Maps / Players do — the API applies them to ``durationSec``, which is
 * the field the Macro Report's game-length segments bucket on, so the
 * two surfaces describe the same cohort rather than two clocks that
 * differ by the ~1.4x "Faster" speed factor.
 *
 * Three quick bands cover the common asks; the Custom pill opens a
 * small popover for an arbitrary range. Default is All — no constraint,
 * no parameter on the wire — so existing bookmarks are unaffected.
 *
 * Deliberately independent of "Hide too-short", which drops the
 * no-build-order cohort by strategy label. The two compose.
 */
export function GameLengthFilter() {
  const { filters, setFilters } = useFilters();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const min = filters.min_minutes;
  const max = filters.max_minutes;
  const isAll = min === undefined && max === undefined;
  const activeBandId = useMemo(
    () => LENGTH_BANDS.find((b) => b.min === min && b.max === max)?.id ?? null,
    [min, max],
  );
  const isCustom = !isAll && activeBandId === null;
  const customLabel = isCustom ? lengthRangeLabel(min, max) : null;

  // Draft state for the custom inputs, seeded from the active range so
  // reopening the popover shows what is currently applied rather than
  // whatever was last typed.
  const [draftMin, setDraftMin] = useState("");
  const [draftMax, setDraftMax] = useState("");
  useEffect(() => {
    setDraftMin(min === undefined ? "" : String(min));
    setDraftMax(max === undefined ? "" : String(max));
  }, [min, max, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const applyBounds = (next: { min_minutes?: number; max_minutes?: number }) => {
    setFilters({ ...filters, ...next });
  };

  const applyCustom = () => {
    // Normalised here as well as on rehydration: the inputs allow a
    // transposed pair, and swapping beats answering a typo with an
    // empty dashboard.
    const bounds = normalizeGameLengthBounds(draftMin, draftMax);
    applyBounds({
      min_minutes: bounds.min_minutes,
      max_minutes: bounds.max_minutes,
    });
    setOpen(false);
  };

  return (
    <div
      role="group"
      aria-label="Filter by game length"
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs uppercase tracking-wider text-text-dim">
        Length
      </span>
      <PillButton
        active={isAll}
        title="Games of any length"
        onClick={() => applyBounds({ min_minutes: undefined, max_minutes: undefined })}
      >
        All
      </PillButton>
      {LENGTH_BANDS.map((band) => (
        <PillButton
          key={band.id}
          active={activeBandId === band.id}
          title={band.title}
          onClick={() =>
            applyBounds({ min_minutes: band.min, max_minutes: band.max })
          }
        >
          {band.label}
        </PillButton>
      ))}

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-pressed={isCustom}
          title={
            customLabel
              ? `Custom range: ${customLabel}`
              : "Filter to a custom game-length range"
          }
          className={[
            "inline-flex min-h-[28px] items-center gap-1 rounded-full border px-2 py-0.5",
            "text-micro font-medium uppercase tracking-wider tabular-nums",
            "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            isCustom
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border text-text-dim hover:bg-bg-elevated hover:text-text",
          ].join(" ")}
        >
          {customLabel ?? "Custom"}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>

        {open ? (
          <>
            <button
              type="button"
              aria-label="Close game length picker"
              className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] sm:bg-transparent sm:backdrop-blur-0"
              onClick={() => setOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Custom game length"
              className={[
                "fixed inset-x-2 bottom-2 z-40 rounded-xl border border-border bg-bg-surface p-4 shadow-card",
                "sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-1 sm:w-[min(92vw,320px)] sm:rounded-lg sm:p-3",
              ].join(" ")}
            >
              <div className="mb-2 flex items-center justify-between sm:hidden">
                <h3 className="text-h3 font-semibold text-text">Game length</h3>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-micro uppercase tracking-wider text-text-dim">
                    Min (min)
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_GAME_LENGTH_MINUTES}
                    value={draftMin}
                    placeholder="any"
                    onChange={(e) => setDraftMin(e.target.value)}
                    className="mt-0.5 min-h-[44px] w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-micro uppercase tracking-wider text-text-dim">
                    Max (min)
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_GAME_LENGTH_MINUTES}
                    value={draftMax}
                    placeholder="any"
                    onChange={(e) => setDraftMax(e.target.value)}
                    className="mt-0.5 min-h-[44px] w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none"
                  />
                </label>
              </div>
              <p className="mt-1.5 text-micro text-text-dim">
                Min included, max excluded — “10 to 20” covers 10:00 through
                19:59. Leave a box empty for no bound.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={applyCustom}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-border bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => {
                    applyBounds({
                      min_minutes: undefined,
                      max_minutes: undefined,
                    });
                    setOpen(false);
                  }}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  Clear
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
