"use client";

import type { TabId } from "@/components/analyzer/tabs";
import { ArcadeTab } from "./ArcadeTab";
import { BattlefieldTab } from "./BattlefieldTab";
import { BuildsTab } from "./BuildsTab";
import { MacroTab } from "./MacroTab";
import { ReplayLibrary } from "./replays/ReplayLibrary";
import { StrategiesTab } from "./StrategiesTab";
import { TrendsTab } from "./TrendsTab";

/**
 * SectionPanel — renders one analyzer section for its /app/<section>
 * route. Opponents is not handled here: /app/opponents has its own
 * routes (list + per-opponent dossier) so a dossier is a real URL.
 */
export function SectionPanel({ tab }: { tab: Exclude<TabId, "opponents"> }) {
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
