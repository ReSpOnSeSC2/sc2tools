import { describe, expect, it, vi } from "vitest";
import { buildScoutingBrief } from "../scoutingBrief";
import type { ScoutingBriefProfile } from "../dossierTypes";

const profile: ScoutingBriefProfile = {
  pulseId: "fixture", name: "Rival", lastSeen: "2026-10-20T12:00:00Z", totals: { wins: 2, losses: 1, total: 3, winRate: 2 / 3 },
  games: [{ result: "Win", my_build: "Blink", opp_strategy: "Roaches", map: "Alpha" }, { result: "Win", my_build: "Blink", opp_strategy: "Roaches", map: "Alpha" }, { result: "Loss", my_build: "One-off", opp_strategy: "Ling", map: "Beta" }],
  byMap: { Alpha: { wins: 2, losses: 0 }, Beta: { wins: 0, losses: 1 } }, byStrategy: { Roaches: { wins: 2, losses: 0 } }, predictedStrategies: [{ strategy: "Roaches", probability: 0.8 }],
  phases: { finalPhaseDistribution: { early: 1, mid: 2 } },
};
describe("scouting brief", () => {
  it("uses at most six factual lines with the >=2-game matrix pairing and supplied cohort", () => {
    const lines = buildScoutingBrief({ ...profile, series: { games: [], sourceLimit: 1000, truncated: false, firstSeen: "2010-01-01", lastSeen: "2026-10-22" } });
    expect(lines).toHaveLength(6); expect(lines[0]).toContain("Oct 22, 2026"); expect(lines[0]).not.toContain("Oct 20, 2026"); expect(lines[0]).toContain("This view: 2W–1L");
    expect(lines.join("\n")).toContain("Blink vs Roaches, 2–0 (100%, n=2)"); expect(lines.join("\n")).toContain("observed in 2 decided games in this view");
    expect(lines.join("\n")).toContain("best Alpha 100% (n=2); toughest Beta 0% (n=1)"); expect(lines.join("\n")).toContain("Usual recorded end phase: mid (n=2)");
    expect(lines.some(line => line.startsWith("In this view:"))).toBe(true);
  });
  it("does not invent missing phase/timing/build evidence or borrow prediction n from another scope", () => {
    const lines = buildScoutingBrief({ games: [{ result: "Win", my_build: "One-off", opp_strategy: "Ling" }], predictedStrategies: [{ strategy: "Ling", probability: 1 }] });
    expect(lines.join("\n")).not.toMatch(/Usual recorded end phase|Best recorded pairing|Likely opener/);
    expect(buildScoutingBrief({})).toEqual(["Last met — · This view: 0W–0L."]);
  });
  it("is deterministic without consulting the clock and bounds a truncated current run", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Unexpected clock read"); });
    const first = buildScoutingBrief({ ...profile, games: profile.games!.slice(0, 2), gamesTruncated: true });
    expect(first[0]).toContain("W≥2"); expect(buildScoutingBrief({ ...profile, games: profile.games!.slice(0, 2), gamesTruncated: true })).toEqual(first); clock.mockRestore();
  });
});
