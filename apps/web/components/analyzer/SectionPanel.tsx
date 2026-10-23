"use client";

import dynamic from "next/dynamic";
import type { TabId } from "@/components/analyzer/tabs";
import { Skeleton } from "@/components/ui/Card";
import { SectionHeader } from "./SectionHeader";

/*
 * Each section is its own chunk: /app/macro no longer downloads the
 * replay library, the Arcade games or the trend charts. While a
 * section's code arrives it shows the same skeleton as the route's
 * loading.tsx, so a client-side switch between sections looks the same
 * as a fresh load.
 */
const ReplayLibrary = dynamic(
  () => import("./replays/ReplayLibrary").then((mod) => mod.ReplayLibrary),
  { loading: () => <Skeleton rows={6} /> },
);
const StrategiesTab = dynamic(
  () => import("./StrategiesTab").then((mod) => mod.StrategiesTab),
  { loading: () => <Skeleton rows={6} /> },
);
const TrendsTab = dynamic(
  () => import("./TrendsTab").then((mod) => mod.TrendsTab),
  { loading: () => <Skeleton rows={6} /> },
);
const MacroTab = dynamic(
  () => import("./MacroTab").then((mod) => mod.MacroTab),
  { loading: () => <Skeleton rows={6} /> },
);
const BattlefieldTab = dynamic(
  () => import("./BattlefieldTab").then((mod) => mod.BattlefieldTab),
  { loading: () => <Skeleton rows={6} /> },
);
const BuildsTab = dynamic(
  () => import("./BuildsTab").then((mod) => mod.BuildsTab),
  { loading: () => <Skeleton rows={6} /> },
);
const ArcadeTab = dynamic(
  () => import("./ArcadeTab").then((mod) => mod.ArcadeTab),
  { loading: () => <Skeleton rows={6} /> },
);

/**
 * SectionPanel — renders one analyzer section for its /app/<section>
 * route, under its SectionHeader (title, intro, "How to read this").
 * Opponents is not handled here: /app/opponents has its own routes
 * (list + per-opponent dossier) so a dossier is a real URL.
 */
export function SectionPanel({ tab }: { tab: Exclude<TabId, "opponents"> }) {
  return (
    <div className="space-y-5">
      <SectionHeader tab={tab} />
      <SectionBody tab={tab} />
    </div>
  );
}

function SectionBody({ tab }: { tab: Exclude<TabId, "opponents"> }) {
  switch (tab) {
    case "replays":
      return <ReplayLibrary />;
    case "strategies":
      return <StrategiesTab />;
    case "trends":
      return <TrendsTab />;
    case "macro":
      return <MacroTab />;
    case "battlefield":
      return <BattlefieldTab />;
    case "builds":
      return <BuildsTab />;
    case "arcade":
      return <ArcadeTab />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}
