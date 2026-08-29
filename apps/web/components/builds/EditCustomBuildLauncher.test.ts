import { describe, expect, it } from "vitest";

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
});
