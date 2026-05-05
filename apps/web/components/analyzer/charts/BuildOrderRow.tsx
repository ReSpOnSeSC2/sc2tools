"use client";

import type { ReactNode } from "react";
import type { BuildEventRow } from "@/lib/build-events";
import { Icon } from "@/components/ui/Icon";

/**
 * BuildOrderRow — one step in the BuildOrderTimeline.
 *
 * Layout:
 *   [time][icon][name + notes][category label]
 *   ──── left rail tinted by category (unit / building / upgrade)
 *
 * On mobile the row reflows so long names wrap rather than forcing
 * horizontal scroll. Min height of 44px keeps the tap target above
 * the iOS HIG floor.
 */
export interface BuildOrderRowProps {
  row: BuildEventRow;
  /** Optional. When provided, the entire row becomes a button. */
  onClick?: (row: BuildEventRow) => void;
  /** Optional secondary line (notes, scouted-at, etc.). */
  notes?: string;
}

const RAIL_CLASSES: Record<BuildEventRow["category"], string> = {
  unit: "before:bg-accent-cyan",
  building: "before:bg-warning",
  upgrade: "before:bg-success",
  other: "before:bg-border-strong",
};

const CATEGORY_LABEL: Record<BuildEventRow["category"], string> = {
  unit: "Unit",
  building: "Building",
  upgrade: "Upgrade",
  other: "Other",
};

const CATEGORY_TEXT_CLASSES: Record<BuildEventRow["category"], string> = {
  unit: "text-accent-cyan",
  building: "text-warning",
  upgrade: "text-success",
  other: "text-text-dim",
};

const BASE_LAYOUT_CLASSES = [
  "relative w-full text-left",
  "flex items-start gap-2 sm:gap-3",
  "min-h-[44px] py-2 pl-3 pr-3 sm:pr-4",
  "border-b border-border last:border-b-0",
  "transition-colors",
  // Left rail (Tailwind needs explicit content for ::before)
  "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1",
];

const INTERACTIVE_CLASSES =
  "hover:bg-bg-elevated focus-visible:outline-none focus-visible:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset cursor-pointer";

export function BuildOrderRow({ row, onClick, notes }: BuildOrderRowProps) {
  const interactive = !!onClick;
  const className = [
    ...BASE_LAYOUT_CLASSES,
    RAIL_CLASSES[row.category],
    interactive ? INTERACTIVE_CLASSES : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <RowContent row={row} notes={notes} />
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onClick?.(row)}
        className={className}
        data-build-event-time={row.time}
        data-build-event-category={row.category}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
      data-build-event-time={row.time}
      data-build-event-category={row.category}
    >
      {content}
    </div>
  );
}

function RowContent({
  row,
  notes,
}: {
  row: BuildEventRow;
  notes?: string;
}): ReactNode {
  return (
    <>
      <span
        className="font-mono tabular-nums text-caption text-text-muted shrink-0 w-12 pt-0.5"
        aria-label={`Time ${row.timeDisplay}`}
      >
        {row.timeDisplay}
      </span>
      <span className="shrink-0 pt-0.5">
        {row.iconPath && row.iconName ? (
          <Icon
            name={row.iconName}
            kind={row.iconKind ?? undefined}
            size={24}
            decorative
          />
        ) : (
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded bg-bg-elevated text-[10px] font-semibold uppercase tracking-wider text-text-dim"
          >
            {(row.displayName || row.rawName).slice(0, 2)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-body text-text">
          {row.displayName}
        </span>
        {notes ? (
          <span className="mt-0.5 block text-caption text-text-dim">
            {notes}
          </span>
        ) : null}
      </span>
      <span
        className={[
          "shrink-0 pt-0.5 text-caption font-medium uppercase tracking-wide",
          CATEGORY_TEXT_CLASSES[row.category],
        ].join(" ")}
      >
        {CATEGORY_LABEL[row.category]}
      </span>
    </>
  );
}
