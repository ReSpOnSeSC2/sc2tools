"use client";

import { PracticeLazy } from "@/components/practice/PracticeLazy";
const load = () => import("./StarGhostReplayContent").then(module => module.StarGhostReplayButton);
export function StarGhostReplayButton(props: Parameters<typeof import("./StarGhostReplayContent").StarGhostReplayButton>[0]) {
  return <PracticeLazy loader={load} componentProps={props} label="Ghost reference" fallback={<button type="button" disabled aria-label="Use replay as Ghost reference" className="min-h-11 px-2 text-caption text-text-muted">Use as Ghost</button>} />;
}
