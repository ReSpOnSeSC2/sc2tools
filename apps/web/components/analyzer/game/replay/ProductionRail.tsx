"use client";

/**
 * ProductionRail — left rail. Two tabs over one side of the game.
 *
 * ``Queue``    what is in production right now, split UNITS /
 *              STRUCTURES / UPGRADES.
 * ``On Field`` what the side actually has: army composition, workers,
 *              structures, and cumulative losses.
 *
 * Honesty notes, because two of these three sections are not the same
 * kind of data:
 *
 *  - UNITS and STRUCTURES are **reconstructed**. ``MapPlayback`` has no
 *    production queues; a unit's ``born`` is when it FINISHED. The
 *    queue is ``born − buildTime ≤ t < born`` over a static SC2
 *    build-time table (``lib/replayHud``). The countdown each bubble
 *    shows is the exact ``born − t`` from the payload, so it is right
 *    regardless of the table; only the instant an item first appears in
 *    the queue depends on it. Warp-ins are a known overshoot — a
 *    warped-in Zealot takes ~5 s, not the 27 s gateway build, so it
 *    joins the queue early.
 *  - UPGRADES has **no data at all**. The payload carries no upgrade
 *    events, so the section renders an explicit empty state and says
 *    what would be needed. It is never faked.
 *  - "On Field" is real: alive-at-t from ``born``/``died``.
 */

import { memo, useId } from "react";
import {
  compositionAt,
  formatClock,
  lossesAt,
  prettyName,
  productionAt,
  structuresAt,
  type QueueGroup,
  type ReplayHudModel,
  type ReplaySide,
} from "@/lib/replayHud";
import type { MapPlayback } from "@/lib/mapReplay";
import { ReplayIcon } from "./ReplayIcon";
import {
  RAIL_CLASS,
  RAIL_HEADER_CLASS,
  SECTION_LABEL_CLASS,
  SIDE_COLOR,
  sideLabel,
} from "./replayTheme";

export type ProductionTab = "queue" | "field";

/** Rows a composition list shows before folding into "+N more". */
const COMP_ROWS_MAX = 12;

function QueueBubble({
  group,
  kind,
}: {
  group: QueueGroup;
  kind: "unit" | "structure";
}) {
  const label = prettyName(group.name);
  const seconds = Math.max(0, Math.ceil(group.remaining));
  return (
    <li
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-1.5 py-1"
      title={`${label} — ${seconds}s remaining${group.count > 1 ? `, ${group.count} in production` : ""}`}
    >
      <ReplayIcon name={group.name} kind={kind} className="h-5 w-5" />
      <span className="whitespace-nowrap text-micro tabular-nums text-text">
        {seconds}s
        {group.count > 1 ? (
          <span className="text-text-muted">{` ×${group.count}`}</span>
        ) : null}
      </span>
      <span className="sr-only">{label}</span>
    </li>
  );
}

function QueueSection({
  label,
  groups,
  kind,
  emptyText = "Idle",
}: {
  label: string;
  groups: QueueGroup[];
  kind: "unit" | "structure";
  emptyText?: string;
}) {
  return (
    <section aria-label={label}>
      <h4 className={SECTION_LABEL_CLASS}>{label}</h4>
      {groups.length === 0 ? (
        <p className="px-2.5 pb-1 text-caption text-text-dim">{emptyText}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5 px-2.5 pb-1">
          {groups.map((g) => (
            <QueueBubble key={g.name} group={g} kind={kind} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CompositionList({
  rows,
  kind,
  emptyText,
}: {
  rows: Array<{ name: string; count: number }>;
  kind: "unit" | "structure";
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <p className="px-2.5 pb-1 text-caption text-text-dim">{emptyText}</p>;
  }
  const shown = rows.slice(0, COMP_ROWS_MAX);
  const folded = rows.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1.5 px-2.5 pb-1">
      {shown.map((r) => (
        <li
          key={r.name}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-1.5 py-1"
          title={`${r.count}× ${prettyName(r.name)}`}
        >
          <ReplayIcon name={r.name} kind={kind} className="h-5 w-5" />
          <span className="text-micro font-semibold tabular-nums text-text">
            {r.count}
          </span>
          <span className="sr-only">{` ${prettyName(r.name)}`}</span>
        </li>
      ))}
      {folded > 0 ? (
        <li className="inline-flex items-center px-1 text-micro text-text-dim">
          +{folded} more
        </li>
      ) : null}
    </ul>
  );
}

function ProductionRailImpl({
  model,
  playback,
  side,
  t,
  tab,
  onTabChange,
  onSideChange,
  myName,
  oppName,
  className = "",
}: {
  model: ReplayHudModel;
  playback: MapPlayback;
  side: ReplaySide;
  t: number;
  tab: ProductionTab;
  onTabChange: (tab: ProductionTab) => void;
  onSideChange: (side: ReplaySide) => void;
  myName?: string | null;
  oppName?: string | null;
  className?: string;
}) {
  const queue = productionAt(model, side, t);
  const comp = compositionAt(model, side, t);
  const structures = structuresAt(playback, side, t);
  const lost = lossesAt(model, side, t);
  const label = sideLabel(side, myName, oppName);
  // Unique per instance: the stage renders one rail, but a page with
  // two replays must not emit duplicate tab ids.
  const uid = useId();

  return (
    <aside
      data-testid="replay-production-rail"
      aria-label={`Production — ${label}`}
      className={`${RAIL_CLASS} ${className}`}
    >
      <div className={RAIL_HEADER_CLASS}>
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: SIDE_COLOR[side] }}
        />
        <span className="min-w-0 flex-1 truncate text-caption font-semibold text-text">
          Production
        </span>
        <button
          type="button"
          onClick={() => onSideChange(side === "me" ? "opp" : "me")}
          aria-label={`Showing ${label}. Switch side.`}
          className="rounded border border-border px-1.5 py-0.5 text-micro font-semibold text-text-muted hover:border-accent hover:text-text"
        >
          {label}
        </button>
      </div>

      <div role="tablist" aria-label="Production view" className="flex gap-1 p-1.5">
        {([
          ["queue", "Queue"],
          ["field", "On Field"],
        ] as const).map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${uid}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${uid}-panel-${id}`}
            onClick={() => onTabChange(id)}
            className={`flex-1 rounded-md border px-2 py-1 text-micro font-semibold ${
              tab === id
                ? "border-accent bg-accent/15 text-text"
                : "border-border bg-bg-elevated text-text-muted hover:border-accent"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {tab === "queue" ? (
          <div
            role="tabpanel"
            id={`${uid}-panel-queue`}
            aria-labelledby={`${uid}-tab-queue`}
          >
            <QueueSection label="Units" groups={queue.units} kind="unit" />
            <QueueSection
              label="Structures"
              groups={queue.structures}
              kind="structure"
            />
            <section aria-label="Upgrades">
              <h4 className={SECTION_LABEL_CLASS}>Upgrades</h4>
              {/* Deliberate empty state: MapPlayback has no upgrade
                  events, so there is nothing to show and nothing
                  defensible to guess. */}
              <p className="px-2.5 pb-1 text-caption text-text-dim">
                Not tracked
                <span className="block text-micro">
                  This replay payload carries no upgrade events.
                </span>
              </p>
            </section>
          </div>
        ) : (
          <div
            role="tabpanel"
            id={`${uid}-panel-field`}
            aria-labelledby={`${uid}-tab-field`}
          >
            <h4 className={SECTION_LABEL_CLASS}>
              Army <span className="text-text-muted">({comp.armyCount})</span>
            </h4>
            <CompositionList rows={comp.army} kind="unit" emptyText="No army" />

            <h4 className={SECTION_LABEL_CLASS}>Workers</h4>
            <p className="px-2.5 pb-1 text-caption tabular-nums text-text">
              {comp.workers}
              <span className="text-text-muted">
                {" "}
                {model.workerName[side] ? prettyName(model.workerName[side] ?? "") : "workers"}
              </span>
            </p>

            <h4 className={SECTION_LABEL_CLASS}>Structures</h4>
            <CompositionList
              rows={structures}
              kind="structure"
              emptyText="None standing"
            />

            <h4 className={SECTION_LABEL_CLASS}>Upgrades</h4>
            <p className="px-2.5 pb-1 text-caption text-text-dim">Not tracked</p>

            <h4 className={SECTION_LABEL_CLASS}>Losses to {formatClock(t)}</h4>
            <p className="px-2.5 pb-1 text-caption tabular-nums text-text">
              {lost.count} units
              <span className="text-text-muted">
                {` · ${lost.minerals.toLocaleString()} minerals · ${lost.gas.toLocaleString()} gas`}
              </span>
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

export const ProductionRail = memo(ProductionRailImpl);
