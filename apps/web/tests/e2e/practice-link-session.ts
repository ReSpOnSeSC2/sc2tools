import { useRef, useState } from "react";
import type { GhostTarget } from "@/lib/ghostBuild";

export const fixtureTarget: GhostTarget = { v: 1, name: "Gateway pressure", steps: [
  { t: 2, supply: 14, name: "Pylon" }, { t: 12, supply: 16, name: "Gateway" },
  { t: 22, supply: 17, name: "Assimilator" }, { t: 32, supply: 20, name: "CyberneticsCore" },
  { t: 42, supply: 23, name: "Nexus" }, { t: 52, supply: 26, name: "Forge" },
] };
export const SINGLE_REPLAY_SESSION_OPTIONS = {};

export function useInstantSession() {
  const file = useRef<File | null>(null);
  const [phase, setPhase] = useState("idle");
  return {
    phase, busy: phase === "choosing", error: phase === "error" ? "not_a_replay" : null, failed: [],
    candidates: [{ toon: "fixture", name: "Local player", race: "Protoss", games: 1 }],
    parsed: phase === "done" ? [{ json: JSON.stringify({
      gameId: "private-fixture-id", date: "2026-11-11", result: "Victory", myRace: "Protoss", gameVersion: "5.0.17",
      buildLog: fixtureTarget.steps.map(step => `[0:${String(step.t).padStart(2, "0")}] ${step.name}`),
    }) }] : [],
    reset: () => { file.current = null; setPhase("idle"); },
    addFiles: async (files: File[]) => { file.current = files[0]; },
    start: async () => { setPhase(file.current?.name.startsWith("broken") ? "error" : "choosing"); },
    choose: async () => setPhase("done"),
  };
}
