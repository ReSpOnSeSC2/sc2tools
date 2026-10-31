"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import {
  defaultAnalyzerFilters,
  describeActiveFilters,
  useFilters,
} from "@/lib/filterContext";

/**
 * Phone layout of the analyzer filter bar. Below `md` the bar keeps the
 * summary and swaps every control for a "Filters · N active"
 * button that opens them in a bottom sheet (focus
 * stays inside, Esc or Done closes it and focus returns to the button).
 * Changes apply as they are made, exactly as on the desktop bar.
 *
 * N counts all filters that differ from the defaults, including the date.
 */
export function FilterSheet({
  children,
}: {
  /** The filter controls, rendered stacked inside the sheet. */
  children: ReactNode;
}) {
  const { filters, setFilters, seasons } = useFilters();
  const [open, setOpen] = useState(false);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const active = useMemo(
    () => describeActiveFilters(filters, { seasons }),
    [filters, seasons],
  );
  const count = active.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-sm text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <SlidersHorizontal className="h-4 w-4 text-text-muted" aria-hidden />
        <span className="font-medium">Filters</span>
        {count > 0 ? (
          <>
            <span aria-hidden className="text-text-dim">
              ·
            </span>
            <span className="font-semibold">{count} active</span>
          </>
        ) : null}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        description="Changes apply right away to filtered analyzer views. Cards with their own scope explain it beside their numbers."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setFilters(defaultAnalyzerFilters(seasons));
                // The button disables itself; keep focus inside the sheet.
                doneRef.current?.focus();
              }}
              disabled={active.length === 0}
            >
              Reset to defaults
            </Button>
            <Button ref={doneRef} onClick={() => setOpen(false)}>
              Done
            </Button>
          </>
        }
      >
        <div className="analyzer-filter-sheet flex w-full min-w-0 flex-col items-start gap-5 [&>*]:min-w-0 [&>*]:max-w-full">
          {children}
        </div>
      </Sheet>
    </>
  );
}
