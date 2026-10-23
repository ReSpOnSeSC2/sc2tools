"use client";

import { useEffect, useState } from "react";
import { useToastOptional } from "@/components/ui/Toast";
import { armGhostTargetForMatchup, clearGhostTarget, emptyGhostBuildConfig, fromBuildLog,
  ghostMatchupKey, readArmedGhostConfig, selectGhostTarget, writeArmedGhostConfig, type GhostTarget } from "@/lib/ghostBuild";

export const GHOST_ARMED_EVENT = "sc2tools:ghost-build-armed";

export function useArmGhostTarget({ name, lines, myRace, opponentRace, gameId }: {
  name: string; lines: ReadonlyArray<string>; myRace?: string | null; opponentRace?: string | null; gameId?: string;
}) {
  const toast = useToastOptional()?.toast;
  const matchup = ghostMatchupKey(myRace, opponentRace);
  const [target, setTarget] = useState<GhostTarget | null>(null);
  const [replacement, setReplacement] = useState<GhostTarget | null>(null);
  useEffect(() => {
    const read = () => setTarget(selectGhostTarget(readArmedGhostConfig(), myRace, opponentRace));
    read(); window.addEventListener(GHOST_ARMED_EVENT, read);
    return () => window.removeEventListener(GHOST_ARMED_EVENT, read);
  }, [myRace, opponentRace]);
  const changed = () => window.dispatchEvent(new Event(GHOST_ARMED_EVENT));
  const save = () => {
    const snapshot = readArmedGhostConfig() ?? emptyGhostBuildConfig();
    const next = fromBuildLog(name, lines, { sourceGameId: gameId });
    if (!next || !matchup || !armGhostTargetForMatchup(myRace, opponentRace, next)) {
      toast?.error("Couldn't arm this build", { description: "A concrete matchup, timed steps and available browser storage are required." });
      return;
    }
    changed(); setReplacement(null);
    toast?.success(`Armed for ${matchup}`, { description: <span>
      Your next games in {matchup} will be graded against this build. Copy the overlay URL in Settings → Overlay. {" "}
      <button className="min-h-11 underline" onClick={() => { if (writeArmedGhostConfig(snapshot)) changed(); }}>Undo</button>
    </span> });
  };
  return { matchup, replacement, target, armed: !!gameId && target?.sourceGameId === gameId,
    arm: () => { const current = selectGhostTarget(readArmedGhostConfig(), myRace, opponentRace);
      if (current && (!gameId || current.sourceGameId !== gameId)) setReplacement(current); else save(); },
    confirm: save, cancel: () => setReplacement(null),
    disarm: () => { if (matchup && writeArmedGhostConfig(clearGhostTarget(readArmedGhostConfig() ?? emptyGhostBuildConfig(), matchup))) changed(); },
  };
}
