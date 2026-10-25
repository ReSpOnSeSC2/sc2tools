// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_TOKENS, getBuildToken, isKnownBuildToken } from "../buildTokens";
import { buildTokenError, buildTokenFitsRace } from "../buildTokenSelection";
import { unitCostCatalog } from "../sc2-units";
import { BUILD_TOKEN_UPGRADE_NAMES } from "../buildTokenUpgrades";
import { PROXY_ELIGIBLE_BUILDINGS, sanitiseRule } from "../build-rules";
import { buildTokenCatalog, renderBuildTokens } from "@/scripts/gen-build-tokens.mjs";
describe("generated known build actions", () => {
  it("is deterministic and matches the checked-in generated catalog", async () => {
    expect(renderBuildTokens(await buildTokenCatalog())).toBe(readFileSync(resolve("lib/buildTokens.ts"), "utf8").replace(/\r\n/g, "\n"));
    expect(new Set(BUILD_TOKENS.map(row => row.token)).size).toBe(BUILD_TOKENS.length);
  });
  it("covers existing unit metadata, replay upgrade aliases and proxy eligibility", () => {
    for (const [name, unit] of Object.entries(unitCostCatalog())) {
      if (!["Protoss", "Terran", "Zerg"].includes(unit.race || "")) continue;
      expect(getBuildToken(`Build${name}`)?.race, name).toBe(unit.race);
    }
    for (const [race, names] of Object.entries(BUILD_TOKEN_UPGRADE_NAMES)) for (const name of names) expect(getBuildToken(`Research${name}`)?.race, name).toBe(race);
    for (const noun of PROXY_ELIGIBLE_BUILDINGS) expect(getBuildToken(`Build${noun}`), noun).toMatchObject({ kind: "building", proxyEligible: true });
    expect(getBuildToken("MorphLair")).toMatchObject({ race: "Zerg", proxyEligible: false });
  });
  it("every offered token passes structural rule sanitization and uses only existing icons", () => {
    for (const row of BUILD_TOKENS) {
      const rule = { type: "before" as const, name: row.token, time_lt: 120 };
      expect(sanitiseRule(rule), row.token).toEqual(rule);
      if (row.icon) expect(existsSync(resolve("public", row.icon.slice(1))), row.icon).toBe(true);
    }
  });
  it("rejects unknown draft actions, preserves exact aliases and validates a selected race", () => {
    expect(isKnownBuildToken("BuildImaginaryThing")).toBe(false); expect(buildTokenError("BuildImaginaryThing")).toMatch(/Unknown action/);
    expect(buildTokenFitsRace("BuildStargate", "Protoss")).toBe(true); expect(buildTokenFitsRace("BuildStargate", "Terran")).toBe(false); expect(buildTokenFitsRace("BuildStargate", "Random")).toBe(true);
    expect(getBuildToken("ResearchBlink")?.token).toBe("ResearchBlink"); expect(getBuildToken("ResearchBlinkTech")?.token).toBe("ResearchBlinkTech");
    expect(buildTokenError("")).toMatch(/Choose/);
  });
});
