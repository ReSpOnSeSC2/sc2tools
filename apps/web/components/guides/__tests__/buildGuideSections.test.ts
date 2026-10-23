import { describe, expect, it } from "vitest";
import { buildGuideSections } from "../build/buildGuideSections";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";

describe("buildGuideSections", () => {
  it("uses the rendering order and excludes absent optional sections", () => {
    const payload = { ...FIXTURE_BUILD_PUBLISHED, videos: [], notes: null, leaks: null, macro: null, eightWorkerVideos: [] };
    expect(buildGuideSections(payload).map((item) => item.id)).toEqual([
      "win-rate-by-band", "key-timings", "army", "vs-openers", "when-it-wins", "maps", "related",
    ]);
  });
  it("keeps the personal record when timings are missing and ignores empty snapshots", () => {
    const payload = { ...FIXTURE_BUILD_PUBLISHED, timings: null, army: {}, bands: { league: [], mmr: [] }, vsStrategy: [], lengths: [], maps: [], related: [], communityBuilds: [], examples: [], notes: null, leaks: null, macro: null, videos: [], eightWorkerVideos: [] };
    expect(buildGuideSections(payload)).toEqual([{ id: "your-record", label: "Your record" }]);
  });
});
