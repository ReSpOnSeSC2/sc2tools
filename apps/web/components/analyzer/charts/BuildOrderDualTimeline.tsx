"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Save } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { normalizeBuildEvents } from "@/lib/build-events";
import { BuildOrderRow } from "./BuildOrderRow";
import { BuildEditorModal } from "@/components/builds/editor";
import type { BuildEventRow } from "@/lib/build-events";
import type {
  BuildOrderEvent,
  BuildPerspective,
  Race,
  VsRace,
} from "./BuildOrderTimeline.types";

const VALID_RACES: ReadonlySet<string> = new Set([
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
]);

const VALID_VS_RACES: ReadonlySet<string> = new Set([
  ...VALID_RACES,
  "Any",
]);

function coerceRace(input: unknown, fallback: Race = "Random"): Race {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (VALID_RACES.has(trimmed)) return trimmed as Race;
  const head = trimmed[0]?.toUpperCase();
  switch (head) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return fallback;
  }
}

function coerceVsRace(input: unknown): VsRace {
  if (typeof input !== "string") return "Any";
  const trimmed = input.trim();
  if (VALID_VS_RACES.has(trimmed)) return trimmed as VsRace;
  if (!trimmed) return "Any";
  const head = trimmed[0]?.toUpperCase();
  switch (head) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return "Any";
  }
}

export interface BuildOrderDualTimelineProps {
  events: BuildOrderEvent[];
  oppEvents?: BuildOrderEvent[];
  gameId?: string;
  race: Race | string | null | undefined;
  oppRace: Race | string | null | undefined;
  myBuildName?: string | null;
  oppBuildName?: string | null;
  onSaved?: (slug: string) => void;
  className?: string;
}

/**
 * BuildOrderDualTimeline — renders both your build AND your opponent's
 * build side-by-side (or stacked on narrow viewports). Each side gets
 * its own "Save as new build" button so the user can capture either
 * perspective into their custom-build library without flipping a
 * toggle. Replaces the segmented "You / Opponent" toggle in surfaces
 * where seeing both at once is the primary task (post-game review,
 * opponent profile drilldown).
 */
export function BuildOrderDualTimeline({
  events,
  oppEvents,
  gameId,
  race,
  oppRace,
  myBuildName,
  oppBuildName,
  onSaved,
  className = "",
}: BuildOrderDualTimelineProps) {
  const myRace = useMemo(() => coerceRace(race), [race]);
  const oppRaceValue = useMemo(() => coerceRace(oppRace), [oppRace]);

  const rowsYou = useMemo(() => normalizeBuildEvents(events), [events]);
  const rowsOpp = useMemo(
    () => normalizeBuildEvents(oppEvents ?? []),
    [oppEvents],
  );

  return (
    <div
      className={[
        "grid grid-cols-1 gap-3 lg:grid-cols-2",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <BuildPanel
        perspective="you"
        title={myBuildName ? `Your build — ${myBuildName}` : "Your build"}
        rows={rowsYou}
        events={events}
        race={myRace}
        vsRace={coerceVsRace(oppRaceValue)}
        gameId={gameId}
        onSaved={onSaved}
        emptyHeadline="No build extracted yet"
        emptyBody="Your build steps come from the .SC2Replay parsed by the agent. Once a game uploads they appear here."
      />
      <BuildPanel
        perspective="opponent"
        title={oppBuildName ? `Opponent's build — ${oppBuildName}` : "Opponent's build"}
        rows={rowsOpp}
        events={oppEvents ?? []}
        race={oppRaceValue}
        vsRace={coerceVsRace(myRace)}
        gameId={gameId}
        onSaved={onSaved}
        emptyHeadline="No opponent build extracted yet"
        emptyBody="Update your desktop agent to v0.4+ and click Resync — newer builds extract the opponent's tech timeline alongside your own."
      />
    </div>
  );
}

function BuildPanel({
  perspective,
  title,
  rows,
  events,
  race,
  vsRace,
  gameId,
  onSaved,
  emptyHeadline,
  emptyBody,
}: {
  perspective: BuildPerspective;
  title: string;
  rows: ReadonlyArray<BuildEventRow>;
  events: ReadonlyArray<BuildOrderEvent>;
  race: Race;
  vsRace: VsRace;
  gameId?: string;
  onSaved?: (slug: string) => void;
  emptyHeadline: string;
  emptyBody: string;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const noEvents = rows.length === 0;

  const handleSaved = useCallback(
    (slug: string) => {
      setEditorOpen(false);
      onSaved?.(slug);
    },
    [onSaved],
  );

  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg-surface/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-bg-surface/80">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={`build-list-${perspective}`}
          onClick={() => setCollapsed((v) => !v)}
          className="-ml-1 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title={collapsed ? "Expand" : "Collapse"}
        >
          <ChevronDown
            className={[
              "h-4 w-4 transition-transform",
              collapsed ? "-rotate-90" : "",
            ].join(" ")}
            aria-hidden
          />
        </button>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
        <span className="text-caption text-text-dim">
          {rows.length} step{rows.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            disabled={noEvents}
            title={
              noEvents
                ? "No build events to save"
                : `Save ${
                    perspective === "opponent" ? "the opponent's" : "your"
                  } build to your library`
            }
            className={[
              "inline-flex h-8 min-h-[32px] items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              noEvents
                ? "cursor-not-allowed border border-border bg-bg-subtle text-text-dim"
                : "border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20",
            ].join(" ")}
          >
            <Save className="h-3.5 w-3.5" aria-hidden />
            Save as new build
          </button>
        </div>
      </header>
      {!collapsed ? (
        <div
          id={`build-list-${perspective}`}
          className="max-h-[520px] overflow-y-auto"
        >
          {rows.length === 0 ? (
            <div className="flex flex-col items-start gap-1 px-4 py-6 text-left sm:items-center sm:text-center">
              <p className="text-body font-semibold text-text">
                {emptyHeadline}
              </p>
              <p className="max-w-md text-caption text-text-muted">
                {emptyBody}
              </p>
            </div>
          ) : (
            <ul role="list" className="flex flex-col">
              {rows.map((row) => (
                <li key={row.key} role="listitem">
                  <BuildOrderRow row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <BuildEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        events={events}
        gameId={gameId}
        race={race}
        vsRace={vsRace}
        perspective={perspective}
        onSaved={(slug) => handleSaved(slug)}
      />
    </Card>
  );
}
