import { describe, expect, it } from "vitest";
import { buildToMarkdownTable, buildToSalt, buildToText, casualtiesToCsv, gameExportFilename, gameToJson, statsToCsv, withBuildSupply } from "../gameExport";
import type { BuildRule } from "../build-rules";

const meta = { title: "Gate expand", matchup: "PvZ", author: "Reaver", sourceUrl: "https://sc2tools.com/community/builds/gate" };
const steps = [{ time: 17, name: "Pylon", supply: 14 }, { time: 42, name: "Gateway", supply: 16, supplyApprox: true }];
describe("build export formats", () => {
  it("writes complete clock/supply text with attribution and source", () => {
    expect(buildToText(steps, meta)).toBe("Gate expand · PvZ · by Reaver\n\n[0:17] 14 Pylon\n[0:42] ≈16 Gateway\n\nhttps://sc2tools.com/community/builds/gate");
    expect(buildToText(steps, meta, "supply-clock")).toContain("≈16 Gateway [0:42]");
    expect(buildToMarkdownTable(steps, meta)).toBe("# Gate expand\nPvZ · by Reaver\n\n| Time | Supply | Step |\n| --- | --- | --- |\n| 0:17 | 14 | Pylon |\n| 0:42 | ≈16 | Gateway |\n\nhttps://sc2tools.com/community/builds/gate");
  });
  it("uses the same rule descriptions as the v3 rule summary without fabricating steps", () => {
    const rules: BuildRule[] = [{ type: "before", name: "BuildStargate", time_lt: 300 }];
    // Use a saved-rule fixture shape, not a prose interpretation of the rule.
    const text = buildToText([], { ...meta, author: null }, "clock", rules);
    expect(text).toContain("by Anonymous"); expect(text).toMatch(/Stargate/); expect(text.endsWith(meta.sourceUrl)).toBe(true);
    expect(text).not.toContain("[0:00]");
  });
  it("reports unsupported SALT items and out-of-range values instead of clamping", () => {
    const result = buildToSalt([...steps, { time: 80, name: "ShieldBattery", supply: 20 }, { time: 90, name: "Marine", supply: 150 }, { time: 5700, name: "Pylon", supply: 14 }], meta);
    expect(result.salt).toBe('$Gate expand  PvZ|Reaver|https://sc2tools.com/community/builds/gate|~* 1 ;, J 8');
    expect(result.skipped).toEqual(["Marine — supply is outside 5–98", "Pylon — time exceeds 94:59", "ShieldBattery"]);
    expect(buildToSalt([{ time: 60, name: "Marine", count: 201 }], meta).skipped).toEqual(["201× Marine — count is outside 1–200 whole steps"]);
  });
  it("uses prior supply, keeps exact/fractional/zero values and leaves pre-sample steps unknown", () => {
    const input = [{ time: 1, name: "A" }, { time: 10, name: "B" }, { time: 20, name: "C", supply: 17 }];
    const result = withBuildSupply(input, [{ time: 15, food_used: 19.5 }, { time: 10, food_used: 0 }]);
    expect(result).toEqual([{ time: 1, name: "A" }, { time: 10, name: "B", supply: 0, supplyApprox: true }, { time: 20, name: "C", supply: 17 }]);
    expect(withBuildSupply([{ time: 16, name: "Zergling" }], [{ time: 15, food_used: 19.5 }])[0].supply).toBe(19.5);
    expect(input[1]).not.toHaveProperty("supply");
  });
});
describe("game downloads", () => {
  it("writes numeric CSV columns without turning unknown measurements into zero", () => {
    expect(statsToCsv([{ time: 1, food_used: 14, minerals_current: 0 }], [{ time: 0, food_used: 12 }])).toBe("time,side,supply_used,supply_cap,workers,bank_minerals,bank_gas,income_minerals,income_gas,army_value\r\n0,opponent,12,,,,,,,\r\n1,you,14,,,0,,,,\r\n");
  });
  it("escapes CSV names and prevents spreadsheet formulas", () => {
    expect(casualtiesToCsv([{ time: 10, owner: "me", name: '=HYPERLINK("bad")', count: 1 }])).toContain('"\'=HYPERLINK(""bad"")"');
    expect(casualtiesToCsv([{ time: 1, name: "Marine, elite" }])).toContain('"Marine, elite"');
  });
  it("versions JSON and constructs filesystem-safe names", () => {
    expect(JSON.parse(gameToJson({ game: { gameId: "g1" }, buildOrders: steps }))).toEqual({ schemaVersion: 1, game: { gameId: "g1" }, buildOrders: steps });
    expect(gameExportFilename("2026-10-23T12:00:00Z", "PvZ", "../Blackrock LE")).toBe("sc2tools-2026-10-23-PvZ-Blackrock-LE");
  });
});
