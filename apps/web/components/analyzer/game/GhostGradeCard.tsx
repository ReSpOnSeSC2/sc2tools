"use client";

import { PracticeLazy } from "@/components/practice/PracticeLazy";
export { GHOST_SYNC_EVENT as GHOST_ARMED_EVENT } from "@/lib/ghostPracticeEvents";
const loadGrade = () => import("./GhostGradeContent").then(module => module.GhostGradeCard);
const loadArm = () => import("./GhostGradeContent").then(module => module.ArmGhostFromLogButton);
export function GhostGradeCard(props: Parameters<typeof import("./GhostGradeContent").GhostGradeCard>[0]) {
  return <PracticeLazy loader={loadGrade} componentProps={props} label="Ghost grade" />;
}
export function ArmGhostFromLogButton(props: Parameters<typeof import("./GhostGradeContent").ArmGhostFromLogButton>[0]) {
  return <PracticeLazy loader={loadArm} componentProps={props} label="Ghost target controls" fallback={<button type="button" disabled className="min-h-11 px-2 text-caption text-text-muted">Loading Ghost…</button>} />;
}
