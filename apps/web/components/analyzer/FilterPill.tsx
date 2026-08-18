"use client";

import type { ReactNode } from "react";

/**
 * The compact toggle the global filter bar is built from — Region, Maps,
 * Players and Game length all render rows of these.
 *
 * Lives in its own module because more than one filter-bar control needs
 * it and the bar itself is already at its file-length budget; keeping the
 * shared primitive here avoids a circular import between the bar and the
 * controls it composes.
 *
 * `aria-pressed` rather than a checkbox role: these are toggles that
 * re-scope the page immediately, not a form the user submits.
 */
export function PillButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={[
        "inline-flex min-h-[28px] items-center rounded-full border px-2 py-0.5",
        "text-micro font-medium uppercase tracking-wider tabular-nums",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        active
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border text-text-dim hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
