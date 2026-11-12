"use client";

import { useState } from "react";
import { BrowserDrill } from "@/components/practice/BrowserDrill";
import { WatchSync } from "@/components/practice/WatchSync";
import { Tabs } from "@/components/ui/Tabs";
import type { ReferenceBuildStep } from "@/lib/buildOrderReference";
import type { GhostTarget } from "@/lib/ghostBuild";

export function PracticeLinkTabs({ videoId, offset, steps, title, drill }: {
  videoId: string; offset: number; steps: readonly ReferenceBuildStep[]; title: string; drill: GhostTarget | null;
}) {
  const [tab, setTab] = useState("watch");
  return <Tabs value={tab} onValueChange={setTab}>
    <Tabs.List ariaLabel="Practice Link activities">
      <Tabs.Trigger value="watch">Watch</Tabs.Trigger>
      <Tabs.Trigger value="drill">Drill</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="watch"><WatchSync videoId={videoId} offset={offset} steps={steps} title={title} /></Tabs.Content>
    <Tabs.Content value="drill">{drill ? <BrowserDrill target={drill} /> : <p className="text-body text-text-muted">This build has no timed steps for a drill.</p>}</Tabs.Content>
  </Tabs>;
}
