"use client";

import { useState } from "react";
import { ChevronDown, Crosshair } from "lucide-react";
import { PracticeLazy } from "./PracticeLazy";
import type { GhostMatchupKey } from "@/lib/ghostBuild";
import type { PracticeInput } from "@/lib/practiceAssignment";

type Props = PracticeInput & { matchup?: GhostMatchupKey; startOpen?: boolean; onClose?: () => void; onPractice?: () => void };
const load = () => import("./PracticeController").then(module => module.PracticeController);
const races: Record<string, string> = { p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z" };
/** No auth, SWR or reference lookup is loaded for each rendered build card. */
export function PracticeButton(props: Props) {
  const [action, setAction] = useState<"quick" | "options" | null>(props.startOpen ? "options" : null);
  const myRace = races[props.build.race?.trim().toLowerCase() ?? ""], theirs = races[props.build.vsRace?.trim().toLowerCase() ?? ""];
  const matchup = props.matchup ?? (myRace && theirs ? `${myRace}v${theirs}` : null);
  if (action) return <PracticeLazy loader={load} componentProps={{ ...props, initialAction: action }} label="practice controls" fallback={<span role="status" className="inline-flex min-h-11 items-center text-caption text-text-muted">Loading practice controls…</span>} />;
  return <span className="inline-flex max-w-full rounded-md border border-border bg-bg-surface" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <button type="button" className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-l-md px-3 text-caption font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setAction("quick")}><Crosshair className="h-4 w-4 shrink-0" aria-hidden />{matchup ? `Practice in ${matchup}` : "Practice this"}</button>
    <button type="button" aria-label={`Practice options for ${props.build.name}`} aria-haspopup="dialog" aria-expanded={false} onClick={() => setAction("options")} className="min-h-11 min-w-11 rounded-r-md border-l border-border px-3 text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><ChevronDown className="h-4 w-4" aria-hidden /></button>
  </span>;
}
