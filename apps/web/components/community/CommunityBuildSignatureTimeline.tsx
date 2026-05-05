"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { signatureToRows } from "@/lib/build-events";
import type { BuildSignatureItem } from "@/lib/build-events";

export interface CommunityBuildSignatureTimelineProps {
  signature: ReadonlyArray<BuildSignatureItem> | null | undefined;
}

const RAIL_CLASSES = {
  unit: "before:bg-accent-cyan",
  building: "before:bg-warning",
  upgrade: "before:bg-success",
  other: "before:bg-border-strong",
} as const;

const CATEGORY_LABEL = {
  unit: "Unit",
  building: "Building",
  upgrade: "Upgrade",
  other: "Other",
} as const;

const CATEGORY_TEXT_CLASSES = {
  unit: "text-accent-cyan",
  building: "text-warning",
  upgrade: "text-success",
  other: "text-text-dim",
} as const;

/**
 * Read-only timeline for a published community build.
 *
 * Differs from BuildOrderTimeline (used on the dashboard) in three
 * ways: no perspective toggle, no save-as-build button, and rows are
 * derived from the persisted `signature` shape rather than per-event
 * stream — each signature entry shows a "×N" qty annotation since one
 * row represents the cumulative production of that unit before its
 * timestamp.
 */
export function CommunityBuildSignatureTimeline({
  signature,
}: CommunityBuildSignatureTimelineProps) {
  const rows = useMemo(
    () => signatureToRows(signature ?? []),
    [signature],
  );

  return (
    <Card padded={false} className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-surface/95 px-4 py-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          Build order
        </h2>
        <span className="text-caption text-text-dim">
          {rows.length} step{rows.length === 1 ? "" : "s"}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-left sm:text-center">
          <p className="text-body font-semibold text-text">
            No build signature published
          </p>
          <p className="mt-1 max-w-md text-caption text-text-muted sm:mx-auto">
            This build doesn&apos;t include a structured signature. Open it in
            your library to add timing data, then republish.
          </p>
        </div>
      ) : (
        <ul role="list" className="flex flex-col">
          {signature?.map((item, index) => {
            const row = rows[index];
            if (!row) return null;
            const count = Number.isFinite(item.count)
              ? Math.max(1, Math.floor(item.count))
              : 1;
            return (
              <li key={row.key} role="listitem">
                <div
                  className={[
                    "relative flex items-start gap-2 sm:gap-3",
                    "min-h-[44px] py-2 pl-3 pr-3 sm:pr-4",
                    "border-b border-border last:border-b-0",
                    "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1",
                    RAIL_CLASSES[row.category],
                  ].join(" ")}
                >
                  <span
                    className="font-mono tabular-nums text-caption text-text-muted shrink-0 w-12 pt-0.5"
                    aria-label={`Before ${row.timeDisplay}`}
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
                      {count > 1 ? (
                        <span className="ml-2 text-caption text-text-muted">
                          ×{count}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span
                    className={[
                      "shrink-0 pt-0.5 text-caption font-medium uppercase tracking-wide",
                      CATEGORY_TEXT_CLASSES[row.category],
                    ].join(" ")}
                  >
                    {CATEGORY_LABEL[row.category]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
