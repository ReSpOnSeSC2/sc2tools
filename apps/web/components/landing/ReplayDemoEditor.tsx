"use client";

import { useMemo } from "react";
import { LazyBuildEditorModal } from "@/components/builds/editor/LazyBuildEditorModal";
import { buildLogToEvents } from "@/lib/build-events";
import type { RaceLite, VsRaceLite } from "@/lib/build-rules";
import type { PreviewDossier, PreviewPlayer } from "./replayDemoPreview";

/** Load the catalog and the build-order converter only after parsing a replay. */
export function ReplayDemoEditor({ dossier, playerIndex, onClose }: {
  dossier: PreviewDossier;
  playerIndex: 0 | 1;
  onClose: () => void;
}) {
  const me = dossier.players[playerIndex] ?? null;
  const opp = dossier.players[playerIndex === 0 ? 1 : 0] ?? null;
  const events = useMemo(() => me ? buildLogToEvents(me.build_log, me.race) : [], [me]);
  return <LazyBuildEditorModal open onClose={onClose} events={events} gameId={dossier.game_id}
    race={coerceRace(me?.race)} vsRace={coerceVsRace(opp?.race)}
    perspective="you" defaultName={defaultBuildName(me, opp)} demoMode />;
}

function coerceRace(r: string | undefined): RaceLite {
  if (r === "Protoss" || r === "Terran" || r === "Zerg" || r === "Random") {
    return r;
  }
  return "Random";
}

function coerceVsRace(r: string | undefined): VsRaceLite {
  if (
    r === "Protoss" ||
    r === "Terran" ||
    r === "Zerg" ||
    r === "Random" ||
    r === "Any"
  ) {
    return r;
  }
  return "Any";
}

function defaultBuildName(
  me: PreviewPlayer | null,
  opp: PreviewPlayer | null,
): string | undefined {
  if (!me || !opp) return undefined;
  const a = me.race?.charAt(0).toUpperCase() || "?";
  const b = opp.race?.charAt(0).toUpperCase() || "?";
  return `${a}v${b} — Custom`;
}
