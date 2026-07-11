"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import {
  normalizeBuildEvents,
  type BuildEventRow,
} from "@/lib/build-events";
import type { GameBuildOrderEvent } from "./types";

export interface BuildOrderColumnsProps {
  myEvents?: GameBuildOrderEvent[] | null;
  oppEvents?: GameBuildOrderEvent[] | null;
  myLabel?: string | null;
  oppLabel?: string | null;
  myStatus?: "ok" | "empty" | "not_extracted";
  oppStatus?: "ok" | "empty" | "not_extracted";
  loading?: boolean;
  /** Optional action row rendered at the top of the MY column body
   *  (e.g. the Ghost Build "Arm this build" affordance). */
  myAction?: ReactNode;
}

const CATEGORY_DOT: Record<string, string> = {
  unit: "bg-accent-cyan",
  building: "bg-accent",
  upgrade: "bg-warning",
  other: "bg-text-dim",
};

/**
 * BuildOrderColumns — my build vs the opponent's, side by side.
 * Events come from GET /v1/games/:id/build-order (the same `[m:ss]
 * Name` build-log lines, parsed server-side) and are normalized
 * through lib/build-events.ts so icons and display names match every
 * other build surface in the app.
 *
 * Mobile: the columns stack and each is collapsible; desktop always
 * shows both expanded. Long lists scroll inside the column, never the
 * page.
 */
export function BuildOrderColumns({
  myEvents,
  oppEvents,
  myLabel,
  oppLabel,
  myStatus,
  oppStatus,
  loading,
  myAction,
}: BuildOrderColumnsProps) {
  const myRows = useMemo(() => normalizeBuildEvents(myEvents), [myEvents]);
  const oppRows = useMemo(() => normalizeBuildEvents(oppEvents), [oppEvents]);

  if (loading) {
    return (
      <Card title="Build orders">
        <div
          className="grid gap-4 md:grid-cols-2"
          aria-busy="true"
          aria-label="Loading build orders"
        >
          {[0, 1].map((col) => (
            <div key={col} className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded bg-bg-elevated"
                />
              ))}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Build orders" data-testid="build-order-columns">
      <div className="grid gap-4 md:grid-cols-2">
        <BuildColumn
          heading={`You — ${(myLabel || "").trim() || "Unclassified"}`}
          rows={myRows}
          status={myStatus}
          testId="build-column-me"
          action={myAction}
        />
        <BuildColumn
          heading={`Opponent — ${(oppLabel || "").trim() || "Unknown"}`}
          rows={oppRows}
          status={oppStatus}
          testId="build-column-opp"
        />
      </div>
    </Card>
  );
}

function BuildColumn({
  heading,
  rows,
  status,
  testId,
  action,
}: {
  heading: string;
  rows: BuildEventRow[];
  status?: "ok" | "empty" | "not_extracted";
  testId: string;
  action?: ReactNode;
}) {
  // Collapsed state only applies below md — the body keeps `md:block`
  // so desktop always shows both columns expanded.
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-bg-elevated/40"
      data-testid={testId}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left md:pointer-events-none"
      >
        <h4 className="truncate text-caption font-semibold text-text">
          {heading}
        </h4>
        <span className="text-text-dim md:hidden" aria-hidden>
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </button>
      <div
        className={[
          "border-t border-border px-3 py-2",
          collapsed ? "hidden md:block" : "block",
        ].join(" ")}
      >
        {action && rows.length > 0 ? (
          <div className="flex justify-end pb-1">{action}</div>
        ) : null}
        {rows.length === 0 ? (
          <p className="py-3 text-caption text-text-muted">
            {status === "not_extracted"
              ? "The agent hasn't extracted this build log yet — a resync from the desktop agent fills it in."
              : "No build events were parsed from this replay."}
          </p>
        ) : (
          <ol className="max-h-96 space-y-0.5 overflow-y-auto pr-1">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex items-center gap-2 rounded px-1 py-0.5 text-caption"
              >
                <span className="w-11 flex-shrink-0 text-right font-mono text-micro tabular-nums text-text-dim">
                  {row.timeDisplay}
                </span>
                {row.iconPath && row.iconName ? (
                  <Icon
                    name={row.iconName}
                    kind={row.iconKind ?? undefined}
                    size={18}
                    fallback=""
                    decorative
                  />
                ) : (
                  <span
                    className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                      CATEGORY_DOT[row.category] || CATEGORY_DOT.other
                    }`}
                    aria-hidden
                  />
                )}
                <span className="truncate text-text" title={row.rawName}>
                  {row.displayName}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
