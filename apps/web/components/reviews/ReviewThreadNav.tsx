"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { THREAD_FILTERS, type StepPosition, type ThreadFilter } from "@/lib/reviewNavigation";

const STEP_BUTTON = "inline-flex min-h-10 items-center gap-0.5 rounded-full px-2.5 font-semibold text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * "‹ Prev · 3 of 12 · Next ›" through the timed comments in replay order.
 * The polite live region repeats where a step landed for screen readers.
 */
export function ThreadStepper({ total, position, announcement, onStep }: {
  total: number;
  position: StepPosition;
  announcement: string;
  onStep: (direction: -1 | 1) => void;
}) {
  return (
    <nav aria-label="Step through timed comments" className="flex items-center gap-1 text-caption" data-testid="review-stepper">
      <button type="button" className={STEP_BUTTON} disabled={!position.prev} onClick={() => onStep(-1)} aria-keyshortcuts="P">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Prev
      </button>
      <span aria-hidden className="text-text-dim">·</span>
      <span className="px-1 font-mono tabular-nums text-text">
        {position.index === null ? `${total} timed comments` : `${position.index + 1} of ${total}`}
      </span>
      <span aria-hidden className="text-text-dim">·</span>
      <button type="button" className={STEP_BUTTON} disabled={!position.next} onClick={() => onStep(1)} aria-keyshortcuts="N">
        Next <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
      <span aria-live="polite" className="sr-only">{announcement}</span>
    </nav>
  );
}

/** AND-combined chips with what each matches on its own. Not persisted. */
export function ThreadFilterChips({ active, counts, hasFocusRange, onToggle }: {
  active: ReadonlySet<ThreadFilter>;
  counts: Record<ThreadFilter, number>;
  hasFocusRange: boolean;
  onToggle: (filter: ThreadFilter) => void;
}) {
  const chips = THREAD_FILTERS.filter((chip) => chip.key !== "focus" || hasFocusRange);
  return (
    <div role="group" aria-label="Filter comments" className="flex flex-wrap items-center gap-1.5 text-caption">
      {chips.map((chip) => {
        const on = active.has(chip.key);
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(chip.key)}
            className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? "border-accent-cyan bg-accent-cyan/15 text-text" : "border-border text-text-muted hover:text-text"}`}
          >
            {chip.label}{" "}
            <span className="font-mono tabular-nums text-text-dim">{counts[chip.key]}</span>
          </button>
        );
      })}
    </div>
  );
}
