"use client";

import { useEffect, useRef, useState } from "react";
import { useToastOptional } from "@/components/ui/Toast";
import { fromBuildLog, ghostMatchupKey, saveGhostBuild, selectGhostTarget, type GhostTarget } from "@/lib/ghostBuild";
import { useGhostPractice } from "@/lib/useGhostPractice";
import { GHOST_SYNC_EVENT } from "@/lib/ghostSyncModel";
export const GHOST_ARMED_EVENT = GHOST_SYNC_EVENT;

export function useArmGhostTarget({ name, lines, myRace, opponentRace, gameId }: {
  name: string; lines: ReadonlyArray<string>; myRace?: string | null; opponentRace?: string | null; gameId?: string;
}) {
  const toast = useToastOptional()?.toast;
  const practice = useGhostPractice();
  const matchup = ghostMatchupKey(myRace, opponentRace);
  const scope = `${practice.owner ?? ""}:${matchup ?? ""}:${gameId ?? ""}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const target = selectGhostTarget(practice.config, myRace, opponentRace);
  const [replacement, setReplacement] = useState<GhostTarget | null>(null);
  useEffect(() => { currentScope.current = scope; setReplacement(null); return () => { currentScope.current = ""; }; }, [scope]);
  const save = async () => {
    const snapshot = target;
    const next = fromBuildLog(name, lines, { sourceGameId: gameId });
    if (!next || !matchup) { toast?.error("Couldn't arm this build", { description: "A concrete matchup and timed steps are required." }); return; }
    if (!await practice.assign(matchup, next, snapshot)) return;
    if (currentScope.current !== scope) return;
    saveGhostBuild(matchup, next); window.dispatchEvent(new Event(GHOST_ARMED_EVENT)); setReplacement(null);
    toast?.success(`Armed for ${matchup}`, { description: <span>
      Your next {matchup} games will be graded against this build. Your Ghost URL updates automatically. {" "}
      <button className="min-h-11 underline" onClick={() => { void practice.assign(matchup, snapshot, next); }}>Undo</button>
    </span> });
  };
  return { matchup, replacement, target, armed: !!gameId && target?.sourceGameId === gameId,
    saving: practice.saving, loading: practice.loading || !!practice.readError, error: practice.error ?? (practice.readError ? "Couldn't load practice assignments." : null), retry: practice.retry, signedIn: !!practice.owner,
    arm: () => { if (target && (!gameId || target.sourceGameId !== gameId)) setReplacement(target); else void save(); },
    confirm: save, cancel: () => setReplacement(null),
    disarm: () => { if (matchup) void practice.assign(matchup, null, target); },
  };
}
