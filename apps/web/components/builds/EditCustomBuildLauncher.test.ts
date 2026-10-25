import { describe, expect, it } from "vitest";

import { normalizeBuildEvent } from "@/lib/build-events";
import { docToEvents } from "./EditCustomBuildLauncher";

describe("EditCustomBuildLauncher proxy round-trip", () => {
  it("reconstructs signature-only source rows in deadline order without losing quantities or proxy evidence", () => {
    const signature = [{ unit: "marine", count: 3, beforeSec: 140.9 }, { unit: "Barracks", count: 2, beforeSec: 80, proxy: true }];
    const events = docToEvents({ slug: "legacy", signature });
    expect(events).toEqual([
      expect.objectContaining({ time: 80, name: "Barracks", display: "Barracks ×2", category: "building", is_proxy: true }),
      expect.objectContaining({ time: 140, name: "Marine", display: "Marine ×3", category: "unit", is_proxy: false }),
    ]);
    expect(signature[0]).toEqual({ unit: "marine", count: 3, beforeSec: 140.9 });
  });
  it("prefers exact rich-rule tokens over a stale legacy signature", () => {
    const events = docToEvents({ slug: "modern", signature: [{ unit: "Gateway", count: 3, beforeSec: 200 }], rules: [{ type: "before", name: "ResearchBlinkTech", time_lt: 300 }] });
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ name: "ResearchBlinkTech", time: 300 });
  });
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
