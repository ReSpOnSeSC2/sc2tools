"use client";

import { normalizeBuildEvents } from "@/lib/build-events";
import { coerceRace, coerceVsRace } from "@/lib/race";
import { SaveAsBuildButton } from "../charts/SaveAsBuildButton";
import { ArmGhostFromLogButton } from "./GhostGradeCard";
import type { GameBuildOrderEvent } from "./types";

export function BuildWorkspaceActions({ events, name, race, vsRace, gameId, opponent = false, ghost = true }: {
  events: GameBuildOrderEvent[]; name: string; race?: string | null; vsRace?: string | null; gameId: string; opponent?: boolean; ghost?: boolean;
}) {
  const rows = normalizeBuildEvents(events);
  return <div className="flex flex-col items-stretch gap-1">
    {ghost ? <ArmGhostFromLogButton name={name} lines={rows.map(row => `[${row.timeDisplay}] ${row.rawName}`)} myRace={race} opponentRace={vsRace} gameId={gameId} className="min-h-11 w-full justify-start" /> : null}
    <SaveAsBuildButton rows={rows} events={events} race={coerceRace(race)} vsRace={coerceVsRace(vsRace)} perspective={opponent ? "opponent" : "you"} defaultName={name} gameId={gameId} className="min-h-11 w-full" />
  </div>;
}
