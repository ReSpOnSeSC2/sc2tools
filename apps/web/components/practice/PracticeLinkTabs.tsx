"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { isMobilePlatform } from "@/components/onboarding/useIsMobileDevice";
import { BrowserDrill } from "@/components/practice/BrowserDrill";
import { WatchSync } from "@/components/practice/WatchSync";
import { Tabs } from "@/components/ui/Tabs";
import type { ReferenceBuildStep } from "@/lib/buildOrderReference";
import type { GhostTarget } from "@/lib/ghostBuild";
import type { PatchEra } from "@/lib/meta";
import type { PracticeGradeCredit } from "@/lib/practice/practiceGradeShareCard";
import type { Race } from "@/lib/race";

const DropGrade = lazy(() => import("./DropGrade").then(module => ({ default: module.DropGrade })));

export function desktopChromium(userAgent: string, maxTouchPoints: number): boolean {
  return /(?:Chrome|Chromium|Edg)\/\d+/.test(userAgent) && !isMobilePlatform(userAgent, maxTouchPoints);
}

function useGradeCapability(enabled: boolean) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(enabled && desktopChromium(navigator.userAgent, navigator.maxTouchPoints)
      && typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && !!globalThis.crypto?.subtle);
  }, [enabled]);
  return allowed;
}

export function PracticeLinkTabs({ videoId, offset, steps, title, drill, grade, race, era, gradeEnabled, credit }: {
  videoId: string; offset: number; steps: readonly ReferenceBuildStep[]; title: string; drill: GhostTarget | null;
  grade: GhostTarget | null; race: Race; era: PatchEra; gradeEnabled: boolean; credit: PracticeGradeCredit;
}) {
  const [tab, setTab] = useState("watch");
  const canGrade = useGradeCapability(gradeEnabled);
  return <Tabs value={tab === "grade" && !canGrade ? "watch" : tab} onValueChange={setTab}>
    <Tabs.List ariaLabel="Practice Link activities">
      <Tabs.Trigger value="watch">Watch</Tabs.Trigger>
      <Tabs.Trigger value="drill">Drill</Tabs.Trigger>
      {canGrade ? <Tabs.Trigger value="grade">Grade</Tabs.Trigger> : null}
    </Tabs.List>
    <Tabs.Content value="watch"><WatchSync videoId={videoId} offset={offset} steps={steps} title={title} /></Tabs.Content>
    <Tabs.Content value="drill">{drill ? <BrowserDrill target={drill} /> : <p className="text-body text-text-muted">This build has no timed steps for a drill.</p>}</Tabs.Content>
    {canGrade ? <Tabs.Content value="grade">{grade ? (
      <Suspense fallback={<p role="status">Loading replay grading…</p>}><DropGrade target={grade} race={race} era={era} credit={credit} /></Suspense>
    ) : <p className="text-body text-text-muted">Grade needs at least six timed structure or upgrade steps recorded from a game.</p>}</Tabs.Content> : null}
  </Tabs>;
}
