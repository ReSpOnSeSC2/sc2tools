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

/**
 * Reason the agent gave for the events array being empty. ``"ok"`` =
 * events present. ``"empty"`` = agent uploaded a build log but it
 * parsed to zero events (almost always a malformed or pre-game-only
 * replay). ``"not_extracted"`` = agent never uploaded a build log for
 * this side (older agent, no Resync, or Blizzard cup format).
 */
export type BuildOrderStatus = "ok" | "empty" | "not_extracted";

export interface BuildOrderDualTimelineProps {
  events: BuildOrderEvent[];
  oppEvents?: BuildOrderEvent[];
  gameId?: string;
  race: Race | string | null | undefined;
  oppRace: Race | string | null | undefined;
  myBuildName?: string | null;
  oppBuildName?: string | null;
  /** Server diagnostic for the "your build" column. */
  myStatus?: BuildOrderStatus;
  /** Server diagnostic for the "opponent's build" column. */
  oppStatus?: BuildOrderStatus;
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
  myStatus,
  oppStatus,
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

  const youEmpty = emptyCopyFor("you", myStatus, events.length);
  const oppEmpty = emptyCopyFor("opponent", oppStatus, (oppEvents ?? []).length);

  return (
    <div
      className={[
        // ``min-w-0`` is applied per-child wrapper below — without it
        // the long build titles + event rows inside each panel can
        // push their column wider than the grid track and overflow
        // the page horizontally.
        "grid grid-cols-1 gap-3 lg:grid-cols-2",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0">
        <BuildPanel
          perspective="you"
          title={myBuildName ? `Your build — ${myBuildName}` : "Your build"}
          rows={rowsYou}
          events={events}
          race={myRace}
          vsRace={coerceVsRace(oppRaceValue)}
          gameId={gameId}
          onSaved={onSaved}
          emptyHeadline={youEmpty.headline}
          emptyBody={youEmpty.body}
        />
      </div>
      <div className="min-w-0">
        <BuildPanel
          perspective="opponent"
          title={oppBuildName ? `Opponent's build — ${oppBuildName}` : "Opponent's build"}
          rows={rowsOpp}
          events={oppEvents ?? []}
          race={oppRaceValue}
          vsRace={coerceVsRace(myRace)}
          gameId={gameId}
          onSaved={onSaved}
          emptyHeadline={oppEmpty.headline}
          emptyBody={oppEmpty.body}
        />
      </div>
    </div>
  );
}

/**
 * Map the server's diagnostic status into a user-facing reason. When
 * the API didn't send a status field we infer one from the event
 * count so the UI works against older API responses too.
 */
function emptyCopyFor(
  side: BuildPerspective,
  status: BuildOrderStatus | undefined,
  eventCount: number,
): { headline: string; body: string } {
  const resolved: BuildOrderStatus =
    status ?? (eventCount > 0 ? "ok" : "not_extracted");
  if (side === "you") {
    if (resolved === "empty") {
      return {
        headline: "This replay had no build events",
        body: "The agent uploaded a build log for this game, but it parsed to zero steps — usually a pre-game-only or otherwise incomplete .SC2Replay. Re-uploading the file via the agent's Resync button is the fastest fix.",
      };
    }
    return {
      headline: "No build extracted yet",
      body: "Your build steps come from the .SC2Replay parsed by the agent. Open the desktop agent and click Resync if this game is older than your current agent version.",
    };
  }
  if (resolved === "empty") {
    return {
      headline: "Opponent's build log parsed to zero steps",
      body: "The agent extracted an opponent build log for this game, but it had no valid events. Often happens with very short games or pre-release ladder builds.",
    };
  }
  return {
    headline: "No opponent build extracted yet",
    body: "Update your desktop agent to v0.4+ and click Resync — newer agents extract the opponent's tech timeline alongside your own.",
  };
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
      {/*
       * Mobile-first header — two rows on narrow viewports so the
       * "Save as new build" CTA never gets pushed off the right edge by
       * a long ``oppBuildName`` (the previous flex-wrap layout silently
       * wrapped the button below the title-row, leaving it visually
       * detached and reported as "missing on mobile"). On ≥640px the
       * second row collapses back into the title row's right edge.
       */}
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b border-border bg-bg-surface/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-bg-surface/80 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
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
          <h3
            className="min-w-0 flex-1 truncate text-caption font-semibold uppercase tracking-wider text-text"
            title={title}
          >
            {title}
          </h3>
          <span className="flex-shrink-0 text-caption text-text-dim">
            {rows.length} step{rows.length === 1 ? "" : "s"}
          </span>
        </div>
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
            "inline-flex h-9 min-h-[36px] w-full flex-shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-caption font-semibold transition-colors sm:w-auto sm:self-center",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface",
            noEvents
              ? "cursor-not-allowed border border-border bg-bg-subtle text-text-dim"
              : "border border-accent/40 bg-accent/15 text-accent hover:bg-accent/25 active:bg-accent/30",
          ].join(" ")}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          Save as new build
        </button>
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
