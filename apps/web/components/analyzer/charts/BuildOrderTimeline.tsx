"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { normalizeBuildEvents } from "@/lib/build-events";
import { BuildOrderRow } from "./BuildOrderRow";
import { BuildOrderPerspectiveToggle } from "./BuildOrderPerspectiveToggle";
import { SaveAsBuildButton } from "./SaveAsBuildButton";
import type {
  BuildOrderTimelineProps,
  BuildPerspective,
  Race,
  SaveAsBuildPayload,
  VsRace,
} from "./BuildOrderTimeline.types";

/**
 * BuildOrderTimeline — vertical icon-rich list of build steps.
 *
 * Replaces the legacy text-only horizontal track. Renders the same
 * data on Dashboard, Builds page (Phase 7), and the opponent profile
 * timings panel so the build view stays consistent across surfaces.
 *
 * Composition:
 *   - Header: title + perspective toggle + save-as-build (optional)
 *   - List: vertical scroll of BuildOrderRow, category-tinted rails,
 *     SC2 icons resolved via lib/build-events.
 *   - Empty state: explanatory paragraph for the active perspective.
 *
 * Mobile (≤640px): the header sticks to the top of the list region
 * so the perspective toggle + save button stay reachable while
 * scrolling the steps.
 */

const VALID_RACES: ReadonlySet<string> = new Set([
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
]);

const VALID_VS_RACES: ReadonlySet<string> = new Set([
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
  "Any",
]);

/** Coerce loose race input ("P", "Protoss", null) to a strict Race value. */
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

export function BuildOrderTimeline({
  events,
  oppEvents,
  perspective: controlledPerspective,
  defaultPerspective = "you",
  onPerspectiveChange,
  onSaveAsBuild,
  gameId,
  race,
  oppRace,
  title,
  emptyStateTitle,
  emptyStateBody,
  className = "",
}: BuildOrderTimelineProps) {
  const isControlled = controlledPerspective !== undefined;
  const [internalPerspective, setInternalPerspective] = useState<BuildPerspective>(
    defaultPerspective,
  );

  // Keep internal state in sync with the controlled prop so consumers
  // that provide it can flip perspective without re-mounting us.
  useEffect(() => {
    if (isControlled && controlledPerspective !== undefined) {
      setInternalPerspective(controlledPerspective);
    }
  }, [isControlled, controlledPerspective]);

  const oppAvailable = Array.isArray(oppEvents) && oppEvents.length > 0;
  const wantOpp = isControlled
    ? controlledPerspective === "opponent"
    : internalPerspective === "opponent";
  const effectivePerspective: BuildPerspective =
    wantOpp && oppAvailable ? "opponent" : "you";

  const rowsYou = useMemo(() => normalizeBuildEvents(events), [events]);
  const rowsOpp = useMemo(
    () => normalizeBuildEvents(oppEvents ?? []),
    [oppEvents],
  );
  const rowsActive =
    effectivePerspective === "opponent" ? rowsOpp : rowsYou;

  const handlePerspectiveChange = useCallback(
    (next: BuildPerspective) => {
      if (next === "opponent" && !oppAvailable) return;
      if (!isControlled) setInternalPerspective(next);
      onPerspectiveChange?.(next);
    },
    [isControlled, oppAvailable, onPerspectiveChange],
  );

  const myRace = useMemo(() => coerceRace(race), [race]);
  const oppRaceValue = useMemo(() => coerceRace(oppRace), [oppRace]);
  const saveRace =
    effectivePerspective === "opponent" ? oppRaceValue : myRace;
  const saveVsRace = useMemo<VsRace>(
    () =>
      coerceVsRace(
        effectivePerspective === "opponent" ? myRace : oppRaceValue,
      ),
    [effectivePerspective, myRace, oppRaceValue],
  );

  const headerTitle = title ?? defaultTitle(effectivePerspective);
  const showHeaderActions =
    !!onSaveAsBuild || rowsYou.length > 0 || rowsOpp.length > 0;

  const handleSaved = useCallback(
    (payload: SaveAsBuildPayload & { slug: string }) => {
      // Parent handler is notification-only — the build is already
      // persisted by the BuildEditorModal's built-in PUT. Errors from
      // the parent's handler must not roll back our success state,
      // so they're swallowed here and the caller is expected to
      // surface them through its own UI.
      try {
        const maybe = onSaveAsBuild?.(payload) as unknown;
        if (
          maybe &&
          typeof maybe === "object" &&
          "catch" in maybe &&
          typeof (maybe as { catch?: unknown }).catch === "function"
        ) {
          (maybe as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow — see comment above */
      }
    },
    [onSaveAsBuild],
  );

  return (
    <Card
      className={[
        "flex flex-col overflow-hidden",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      padded={false}
    >
      {/*
       * Header lives INSIDE the scroll region so it sticks to the
       * top of the list when the user scrolls long timelines on
       * mobile — keeps the perspective toggle + save button reachable.
       */}
      <div className="max-h-[520px] overflow-y-auto">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg-surface/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg-surface/80">
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            {headerTitle}
          </h3>
          <span className="text-caption text-text-dim">
            {rowsActive.length} step{rowsActive.length === 1 ? "" : "s"}
          </span>
          {showHeaderActions ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <BuildOrderPerspectiveToggle
                value={effectivePerspective}
                onChange={handlePerspectiveChange}
                opponentAvailable={oppAvailable}
              />
              {onSaveAsBuild ? (
                <SaveAsBuildButton
                  rows={rowsActive}
                  events={
                    effectivePerspective === "opponent"
                      ? oppEvents ?? []
                      : events
                  }
                  perspective={effectivePerspective}
                  race={saveRace}
                  vsRace={saveVsRace}
                  gameId={gameId}
                  onSaved={handleSaved}
                />
              ) : null}
            </div>
          ) : null}
        </header>
        {rowsActive.length === 0 ? (
          <BuildOrderEmpty
            perspective={effectivePerspective}
            title={emptyStateTitle}
            body={emptyStateBody}
            opponentAvailable={oppAvailable}
          />
        ) : (
          <ul role="list" className="flex flex-col">
            {rowsActive.map((row) => (
              <li key={row.key} role="listitem">
                <BuildOrderRow row={row} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function defaultTitle(perspective: BuildPerspective): string {
  return perspective === "opponent" ? "Opponent's build" : "Your build";
}

function BuildOrderEmpty({
  perspective,
  title,
  body,
  opponentAvailable,
}: {
  perspective: BuildPerspective;
  title?: string;
  body?: string;
  opponentAvailable: boolean;
}) {
  const headline =
    title ??
    (perspective === "opponent"
      ? "No opponent build extracted yet"
      : "No build extracted yet");
  const explanation =
    body ??
    (perspective === "opponent"
      ? opponentAvailable
        ? "Switch perspectives to see your build."
        : "The opponent's build wasn't captured for this game. Re-running the agent on the original .SC2Replay file will populate it."
      : "Build steps are extracted from the .SC2Replay file by the desktop agent. Once a game uploads, this view fills in.");
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-8 text-left sm:items-center sm:text-center">
      <p className="text-body font-semibold text-text">{headline}</p>
      <p className="max-w-md text-caption text-text-muted">{explanation}</p>
    </div>
  );
}
