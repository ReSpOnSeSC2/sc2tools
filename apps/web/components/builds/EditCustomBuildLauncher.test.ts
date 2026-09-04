import { describe, expect, it } from "vitest";

import { normalizeBuildEvent } from "@/lib/build-events";
import { docToEvents } from "./EditCustomBuildLauncher";

describe("EditCustomBuildLauncher proxy round-trip", () => {
  it("reconstructs proxy evidence for a saved v3 rule", () => {
    expect(docToEvents({
      slug: "proxy-gateway",
      rules: [{
        type: "before",
        name: "BuildGateway",
        time_lt: 100,
        proxy: true,
      }],
    })).toEqual([expect.objectContaining({
      name: "BuildGateway",
      category: "building",
      is_building: true,
      is_proxy: true,
    })]);
  });

  it("reconstructs proxy evidence for a legacy signature", () => {
    expect(docToEvents({
      slug: "proxy-barracks",
      signature: [{
        unit: "Barracks",
        count: 1,
        beforeSec: 90,
        proxy: true,
      }],
    })).toEqual([expect.objectContaining({
      category: "building",
      is_building: true,
      is_proxy: true,
    })]);
  });

  it("reconstructs a Glaives rule with a friendly display and its raw token intact", () => {
    const events = docToEvents({
      slug: "glaives",
      rules: [{
        type: "before",
        name: "ResearchAdeptPiercingAttack",
        time_lt: 330,
      }],
    });
    expect(events).toEqual([expect.objectContaining({
      name: "ResearchAdeptPiercingAttack",
      display: "Research Resonating Glaives",
    })]);
    expect(normalizeBuildEvent(events[0], 0)).toMatchObject({
      rawName: "ResearchAdeptPiercingAttack",
      displayName: "Research Resonating Glaives",
      category: "upgrade",
      iconPath: "/icons/sc2/upgrades/resonatingglaives.png",
    });
  });
});
