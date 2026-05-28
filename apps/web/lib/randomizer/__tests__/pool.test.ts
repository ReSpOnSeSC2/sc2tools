import { describe, expect, it } from "vitest";
import { candidatePool, customCandidates } from "@/lib/randomizer/pool";
import type { CustomBuild } from "@/components/builds/types";

const CUSTOM: CustomBuild[] = [
  { slug: "ffe-classic", name: "FFE Classic", race: "Protoss", vsRace: "Zerg" },
  { slug: "anti-cheese", name: "Anti-cheese", race: "Protoss", vsRace: "Any" },
  { slug: "marine-rush", name: "Marine Rush", race: "Terran", vsRace: "Zerg" },
];

describe("customCandidates", () => {
  it("filters by matchup races", () => {
    const pvz = customCandidates("PvZ", CUSTOM);
    const names = pvz.map((c) => c.name);
    expect(names).toContain("FFE Classic");
    expect(names).toContain("Anti-cheese");
    expect(names).not.toContain("Marine Rush");
  });

  it('passes through "Any" vsRace', () => {
    const pvp = customCandidates("PvP", CUSTOM);
    expect(pvp.map((c) => c.name)).toContain("Anti-cheese");
    // PvP should not include the Zerg-specific FFE.
    expect(pvp.map((c) => c.name)).not.toContain("FFE Classic");
  });

  it("prefixes custom ids", () => {
    const list = customCandidates("PvZ", CUSTOM);
    for (const c of list) expect(c.id.startsWith("custom:")).toBe(true);
  });
});

describe("candidatePool", () => {
  it("includes catalog Protoss entries for PvP", () => {
    const pool = candidatePool("PvP", []);
    // The bundled catalog ships PvP-specific entries.
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((c) => c.race === "Protoss")).toBe(true);
  });

  it("merges custom builds after catalog", () => {
    const pool = candidatePool("PvZ", CUSTOM);
    const sources = pool.map((c) => c.source);
    // Catalog entries come first.
    const firstCustom = sources.indexOf("custom");
    if (firstCustom !== -1) {
      const beforeFirstCustom = sources.slice(0, firstCustom);
      expect(beforeFirstCustom.every((s) => s === "catalog")).toBe(true);
    }
  });
});
