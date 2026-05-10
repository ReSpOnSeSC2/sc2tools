"use client";

import { useState } from "react";
import { Tabs } from "@/components/ui/Tabs";
import { TodaySurface } from "./arcade/surfaces/Today";
import { QuickPlaySurface } from "./arcade/surfaces/QuickPlay";
import { CollectionSurface } from "./arcade/surfaces/Collection";
import { MyStatsSurface } from "./arcade/surfaces/MyStats";

type Sub = "today" | "quick-play" | "collection" | "my-stats";

const SUBS: Array<{ id: Sub; label: string }> = [
  { id: "today", label: "Today" },
  { id: "quick-play", label: "Quick Play" },
  { id: "collection", label: "Collection" },
  { id: "my-stats", label: "My Stats" },
];

/**
 * ArcadeTab — root surface mounted by AnalyzerShell. Owns the
 * sub-navigation; each sub renders its own surface and composes the
 * shared engine + state hooks.
 */
export function ArcadeTab() {
  const [sub, setSub] = useState<Sub>("today");
  return (
    <div className="space-y-4">
      <Tabs value={sub} onValueChange={(v) => setSub(v as Sub)} orientation="horizontal">
        <Tabs.List ariaLabel="Arcade sections" className="!flex-nowrap overflow-x-auto">
          {SUBS.map((s) => (
            <Tabs.Trigger key={s.id} value={s.id} className="!flex-shrink-0">
              {s.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs>

      {sub === "today" ? <TodaySurface /> : null}
      {sub === "quick-play" ? <QuickPlaySurface /> : null}
      {sub === "collection" ? <CollectionSurface /> : null}
      {sub === "my-stats" ? <MyStatsSurface /> : null}
    </div>
  );
}
