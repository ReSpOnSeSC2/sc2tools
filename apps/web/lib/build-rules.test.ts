import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  eventsToSourceRows,
  ruleFromEvent,
  sanitiseDraft,
  sanitiseRule,
  isProxyStructureLabel,
  signatureUnitToRuleToken,
  PROXY_ELIGIBLE_BUILDINGS,
  type BuildRule,
} from "./build-rules";
import { ruleEntity } from "./build-rules-copy";
import { withQuantifier } from "./build-rules-quantity";
import { rulesToSignature, signatureToRows } from "./build-events";

describe("proxy build rules", () => {
  test("manual signature labels use the same proxy structure eligibility", () => {
    expect(signatureUnitToRuleToken("Cybernetics Core")).toBe(
      "BuildCyberneticsCore",
    );
    expect(signatureUnitToRuleToken("BuildBarracks")).toBe("BuildBarracks");
    expect(signatureUnitToRuleToken("cyberneticscore")).toBe(
      "BuildCyberneticsCore",
    );
    expect(signatureUnitToRuleToken("commandcenter")).toBe(
      "BuildCommandCenter",
    );
    expect(isProxyStructureLabel("Cybernetics Core")).toBe(true);
    expect(isProxyStructureLabel("photoncannon")).toBe(true);
    expect(isProxyStructureLabel("spawningpool")).toBe(true);
    expect(isProxyStructureLabel("Stalker")).toBe(false);
  });

  test("save-from-replay carries canonical proxy evidence into the rule", () => {
    const event = {
      time: 90,
      name: "Barracks",
      display: "Barracks",
      is_building: true,
      is_proxy: true,
    };
    expect(eventsToSourceRows([event])[0].isProxy).toBe(true);
    expect(ruleFromEvent(event)).toEqual({
      type: "before",
      name: "BuildBarracks",
      time_lt: 120,
      proxy: true,
    });
  });

  test("quantity changes and sanitising preserve valid proxy requirements", () => {
    const rule: BuildRule = {
      type: "before",
      name: "BuildBarracks",
      time_lt: 120,
      proxy: true,
    };
    expect(withQuantifier(rule, "exactly").proxy).toBe(true);
    expect(sanitiseRule(rule)).toEqual(rule);
    expect(ruleEntity(rule, 1)).toBe("proxied Barracks");
  });

  test("sanitising drops proxy from non-structure tokens", () => {
    expect(sanitiseRule({
      type: "before",
      name: "BuildMarine",
      time_lt: 120,
      proxy: true,
    })).toEqual({ type: "before", name: "BuildMarine", time_lt: 120 });
    for (const name of [
      "BuildNydusWorm",
      "BuildSupplyDepot",
      "BuildShieldBattery",
      "BuildBarracksFlying",
      "BuildWarpGate",
      "BuildLair",
    ]) {
      expect(sanitiseRule({
        type: "before", name, time_lt: 120, proxy: true,
      })).toEqual({ type: "before", name, time_lt: 120 });
    }
    expect(sanitiseRule({
      type: "before",
      name: "BuildNydusNetwork",
      time_lt: 120,
      proxy: true,
    })).toMatchObject({ proxy: true });
  });

  test("draft validation blocks an invalid proxy target instead of silently downgrading it", () => {
    const result = sanitiseDraft({
      name: "Proxy marine",
      description: "",
      race: "Terran",
      vsRace: "Protoss",
      skillLevel: null,
      shareWithCommunity: false,
      winConditions: [],
      losesTo: [],
      transitionsInto: [],
      rules: [{
        type: "before",
        name: "BuildMarine",
        time_lt: 120,
        proxy: true,
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.rules).toBe(
      "“Only count proxied” needs a building token, for example BuildPylon or BuildBarracks.",
    );
  });

  test("web proxy eligibility exactly matches the local JSON schema", () => {
    const schema = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "../replay-engine/data/custom_builds.schema.json",
    ), "utf8"));
    const schemaNames = schema.definitions.proxyStructureName.enum
      .map((token: string) => token.slice("Build".length))
      .sort();
    expect([...PROXY_ELIGIBLE_BUILDINGS].sort()).toEqual(schemaNames);
  });

  test("community rule timeline retains the proxy label", () => {
    const signature = rulesToSignature([{
      type: "before",
      name: "BuildGateway",
      time_lt: 100,
      proxy: true,
    }]);
    expect(signature[0].proxy).toBe(true);
    expect(signatureToRows(signature)[0].isProxy).toBe(true);
  });
});

describe("upgrade display names", () => {
  test("community rule timeline displays Glaives while preserving its rule token", () => {
    const signature = rulesToSignature([{
      type: "before",
      name: "ResearchAdeptPiercingAttack",
      time_lt: 330,
    }]);
    expect(signature[0].unit).toBe("ResearchAdeptPiercingAttack");
    expect(signatureToRows(signature)[0]).toMatchObject({
      rawName: "ResearchAdeptPiercingAttack",
      displayName: "Research Resonating Glaives",
      category: "upgrade",
      iconPath: "/icons/sc2/upgrades/resonatingglaives.png",
    });
  });
});
