import { describe, expect, it } from "vitest";
import { parseStrategyDrill, serializeStrategyDrill } from "../strategyDrillUrl";
describe("Strategy drill links", () => {
  it("round-trips both clicked axes and a local matchup with punctuation and Unicode", () => {
    const drill = { build: 'PvZ: Gateway | "timing"', opp_strategy: "2 base: 압박", opp_race: "Z" };
    const params = new URLSearchParams(); params.set("drill", serializeStrategyDrill(drill)!);
    expect(parseStrategyDrill(new URLSearchParams(params.toString()).get("drill"))).toEqual(drill);
    expect([...params.keys()]).toEqual(["drill"]);
  });
  it("accepts readable standalone strategy/build links and defaults to closed", () => {
    expect(parseStrategyDrill("strategy:12 Pool")).toEqual({ opp_strategy: "12 Pool" });
    expect(parseStrategyDrill("build:Gateway")).toEqual({ build: "Gateway", opp_strategy: "" });
    expect(serializeStrategyDrill(null)).toBeNull(); expect(parseStrategyDrill(null)).toBeNull();
  });
  it("rejects oversized, malformed, unknown-axis and control-character inputs", () => {
    for (const value of ["opponent:Name", "strategy:", "strategy:x\n", `strategy:${"x".repeat(201)}`, 'build:{"build":"A","strategy":"B","owner":"other"}', 'build:{"build":"A","strategy":"B","race":"Unknown"}']) expect(parseStrategyDrill(value)).toBeNull();
  });
});
