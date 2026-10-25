// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CommunityAuthorProfile, CommunityBuildDetail } from "@/components/community/types";
import { communityAuthorOg, communityBuildOg, marketingOg } from "./publicOgData";

const detail = (build: Record<string, unknown>): CommunityBuildDetail => ({
  slug: "public-build", title: "Public opening", description: "Public description",
  matchup: "PvZ", votes: -3, publishedAt: "2026-10-01T00:00:00Z",
  build: build as CommunityBuildDetail["build"],
});

describe("public social card projection", () => {
  it("shows only five chronological positive rule deadlines", () => {
    const card = communityBuildOg(detail({ rules: [
      { type: "count_min", name: "TrainVoidRay", count: 4, time_lt: 420 },
      { type: "before", name: "BuildNexus", time_lt: 120 },
      { type: "before", name: "BuildGateway", time_lt: 58 },
      { type: "before", name: "BuildAssimilator", time_lt: 75 },
      { type: "before", name: "BuildCyberneticsCore", time_lt: 100 },
      { type: "before", name: "BuildPylon", time_lt: 18 },
      { type: "count_max", name: "BuildForge", count: 2, time_lt: 10 },
      { type: "count_min", name: "BuildStargate", count: 0, time_lt: 10 },
      { type: "before", name: "../private", time_lt: 1 },
    ] }));
    expect(card.steps.map(row => row.name)).toEqual(["Pylon", "Gateway", "Assimilator", "Cybernetics Core", "Nexus"]);
    expect(card.steps.map(row => row.time)).toEqual(["by 0:18", "by 0:58", "by 1:15", "by 1:40", "by 2:00"]);
    expect(card.stepsLabel).toBe("Opening rule deadlines");
    expect(card.stats).toEqual([{ label: "Net votes", value: "-3" }]);
  });

  it("does not resurrect legacy steps when current rules are only exclusions", () => {
    expect(communityBuildOg(detail({ rules: [{ type: "count_max", name: "BuildNexus", count: 1, time_lt: 200 }],
      signature: [{ unit: "Pylon", count: 1, beforeSec: 20 }] })).steps).toEqual([]);
  });

  it("supports positive legacy signatures without inventing units at zero", () => {
    const card = communityBuildOg(detail({ signature: [
      { unit: "Stargate", count: 2, beforeSec: 240 },
      { unit: "VoidRay", count: 4, beforeSec: 420 },
      { unit: "Pylon", count: 0, beforeSec: 20 },
      { unit: "Probe", count: 12, beforeSec: 0 },
    ] }));
    expect(card.steps.map(row => [row.name, row.time])).toEqual([["2× Stargate", "by 4:00"], ["4× Void Ray", "by 7:00"]]);
  });

  it("bounds malformed constraints and rounds fractional upper bounds outward", () => {
    const card = communityBuildOg(detail({ rules: [
      { type: "before", name: "BuildNexus", time_lt: 420.01 },
      { type: "before", name: "BuildPylon", time_lt: -1 },
      { type: "before", name: "BuildGateway", time_lt: Infinity },
      { type: "before", name: "BuildForge", time_lt: 1800.01 },
      { type: "count_exact", name: "BuildStargate", count: 201, time_lt: 300 },
    ] }));
    expect(card.steps.map(row => row.time)).toEqual(["by 7:01"]);
  });

  it("omits private/provenance fields and safely handles malformed author text", () => {
    const data = { ...detail({ sourceGameId: "private-game", notes: "private-note", rules: [] }),
      ownerUserId: "private-owner", authorName: 12, title: "<b>Public</b>\u0000 opening" } as unknown as CommunityBuildDetail;
    const card = communityBuildOg(data);
    expect(card.title).toBe("Public opening");
    expect(card.subtitle).toBe("Published anonymously");
    expect(JSON.stringify(card)).not.toMatch(/private-(?:owner|game|note)/);
  });

  it("keeps author totals public, signed where appropriate and bounded", () => {
    const author = { userId: "private-id", displayName: "Public author", primaryRace: "Protoss", totalBuilds: 2, totalVotes: -7 } as CommunityAuthorProfile;
    const card = communityAuthorOg(author);
    expect(card.stats.map(row => row.value)).toEqual(["2", "-7"]);
    expect(JSON.stringify(card)).not.toContain("private-id");
    expect(communityAuthorOg({ ...author, totalBuilds: -1, totalVotes: 1e300 }).stats.map(row => row.value)).toEqual(["—", "—"]);
  });

  it("provides neutral public marketing cards without account data", () => {
    expect(marketingOg("try").steps).toEqual([]);
    expect(marketingOg("download").title).toContain("replay");
  });
});
