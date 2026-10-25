"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { CopyViewLink } from "./CopyViewLink";
import {
  applyFilterPatch,
  defaultAnalyzerFilters,
  describeActiveFilters,
  useFilters,
  type ActiveFilter,
  type ActiveFilterKey,
} from "@/lib/filterContext";

/**
 * The "Active filters" row under the analyzer filter bar: one removable
 * chip per filter that differs from the defaults, and "Reset to
 * defaults". It is the one place every filter shows, including the
 * drill-downs picked in Strategies (your build, the opponent's strategy),
 * which keep applying to every section until cleared here.
 *
 * Shows nothing while the defaults are in force. Removing a chip moves
 * focus to the next chip (or the previous one, or this row when none is
 * left) and announces the change, so keyboard and screen-reader users
 * keep their place.
 */
export function ActiveFilterChips({ className = "" }: { className?: string }) {
  const { filters, setFilters, seasons } = useFilters();
  const active = useMemo(
    () => describeActiveFilters(filters, { seasons }),
    [filters, seasons],
  );
  const labelId = useId();
  const [announcement, setAnnouncement] = useState("");
  const rowRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<ActiveFilterKey, HTMLButtonElement>());
  // Index of the chip to focus once a removal has re-rendered the row.
  const focusIndex = useRef<number | null>(null);

  useEffect(() => {
    const index = focusIndex.current;
    if (index === null) return;
    focusIndex.current = null;
    const next = active[Math.min(index, active.length - 1)];
    const target = next ? chipRefs.current.get(next.key) : undefined;
    (target ?? rowRef.current)?.focus();
  }, [active]);

  const remove = (chip: ActiveFilter, index: number) => {
    focusIndex.current = index;
    setFilters(applyFilterPatch(filters, chip.clearPatch));
    const left = active.length - 1;
    const count = left === 0 ? "No filters" : `${left} ${left === 1 ? "filter" : "filters"}`;
    setAnnouncement(`Removed ${chip.label}: ${chip.value}. ${count} active.`);
  };

  const reset = () => {
    focusIndex.current = 0;
    setFilters(defaultAnalyzerFilters(seasons));
    setAnnouncement("Filters reset to defaults.");
  };

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={[active.length > 0 ? className : "", "focus:outline-none"].filter(Boolean).join(" ")}
      data-testid="active-filter-chips"
    >
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <CopyViewLink />
      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="text-micro uppercase tracking-wider text-text-dim">
            Active filters
          </span>
          <ul aria-labelledby={labelId} className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {active.map((chip, index) => (
              <li key={chip.key} className="min-w-0 max-w-full">
                <button
                  ref={(el) => {
                    if (el) chipRefs.current.set(chip.key, el);
                    else chipRefs.current.delete(chip.key);
                  }}
                  type="button"
                  onClick={() => remove(chip, index)}
                  aria-label={`Remove filter ${chip.label}: ${chip.value}${chip.setIn ? `, set in ${chip.setIn}` : ""}`}
                  title={chip.setIn ? `${chip.value} (set in ${chip.setIn})` : chip.value}
                  className={[
                    "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 pl-3 pr-2 text-left text-caption text-text sm:min-h-8",
                    "transition-colors hover:border-accent hover:bg-accent/20",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  ].join(" ")}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-text-muted">{chip.label}:</span>{" "}
                    <span className="font-semibold">{chip.value}</span>
                    {chip.setIn ? (
                      <span className="text-text-dim"> · set in {chip.setIn}</span>
                    ) : null}
                  </span>
                  <X className="h-3.5 w-3.5 shrink-0 text-accent-cyan" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-caption font-semibold text-text-muted transition-colors hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:ml-auto sm:min-h-8"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset to defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}
