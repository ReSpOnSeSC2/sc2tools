import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import {
  buildGuideCatalog,
  GUIDE_NON_OPENER_IDS,
  isGuideOpenerDefinition,
} from "@/lib/guides/catalog";
import {
  GUIDE_MATCHUPS,
  guideBuildOptions,
  guideBuildPath,
  guideBuildSlug,
  guideCounterPath,
  guideDisplayName,
  guideMapPath,
  guideMatchupPath,
  guideSlugify,
  guideSlugTable,
  guideStrategyOptions,
  guideStrategySlug,
  isGuideMatchup,
  matchupFromBuildName,
  matchupFromGuideSlug,
} from "@/lib/guides/slugs";

// The API ships its own copies (it cannot import apps/web); these drift
// tests keep them identical. Precedent: lib/build-rules.test.ts.
function readApiConfig(file: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "../api/src/config", file), "utf8"),
  );
}

/** The API's slug module (CommonJS, dependency-free) for rule-parity checks. */
interface ApiGuideSlugs {
  slugifyGuideText(text: string): string;
  mapSlug(mapName: unknown): string | null;
}

function loadApiGuideSlugs(): ApiGuideSlugs {
  const load = createRequire(import.meta.url);
  return load(resolve(process.cwd(), "../api/src/config/guideSlugs.js")) as ApiGuideSlugs;
}

/** Real ladder map names the API ships (1v1 and team pools). */
function realMapNames(): string[] {
  const pool = JSON.parse(
    readFileSync(resolve(process.cwd(), "../api/data/ladder-map-pool.json"), "utf8"),
  ) as { maps?: unknown; teamMaps?: unknown };
  return [pool.maps, pool.teamMaps]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((name): name is string => typeof name === "string");
}

const SLUG_EDGE_CASES: ReadonlyArray<string> = [
  "",
  "  Ghost River LE ",
  "Pylône LE",
  "İstanbul LE",
  "ﬁeld of Dreams",
  "아이어",
  "Rail's Disruptor Drop",
  "2 Base Roach/Ravager All-in",
  `${"a".repeat(79)} b`,
  "x".repeat(120),
];

describe("guide catalog export", () => {
  test("apps/api guideCatalog.json matches the web catalog (re-run `npm run guides:catalog`)", () => {
    expect(readApiConfig("guideCatalog.json")).toEqual(buildGuideCatalog());
  });

  test("every non-opener id still exists in the catalog", () => {
    const ids = new Set(BUILD_DEFINITIONS.map((def) => def.id));
    for (const id of GUIDE_NON_OPENER_IDS) expect(ids.has(id), id).toBe(true);
  });

  test("openers exclude compositions, catch-alls and game-length markers", () => {
    const opener = (name: string) =>
      isGuideOpenerDefinition({ id: guideSlugify(name), name });
    expect(opener("PvZ - Stargate into Glaives")).toBe(true);
    expect(opener("Zerg - 12 Pool")).toBe(true);
    expect(opener("Zerg - Hydra Comp")).toBe(false);
    expect(opener("Protoss - Gateway / Robo (Immortal/Colossus) Comp")).toBe(false);
    expect(opener("PvT - Macro Transition (Unclassified)")).toBe(false);
    expect(opener("Unclassified - Protoss")).toBe(false);
    expect(opener("ZvZ - Game Too Short")).toBe(false);
    expect(isGuideOpenerDefinition({ id: "terran-skyterran", name: "Terran - SkyTerran" })).toBe(false);
  });

  test("catalog is sorted by name with a fixed key order", () => {
    const catalog = buildGuideCatalog();
    const names = catalog.map((entry) => entry.name);
    expect([...names].sort()).toEqual(names);
    expect(Object.keys(catalog[0] ?? {})).toEqual([
      "name",
      "race",
      "matchup",
      "description",
      "opener",
    ]);
  });
});

describe("guide slug table", () => {
  test("web mapping deep-equals the API lock (guideSlugs.lock.json)", () => {
    expect(guideSlugTable()).toEqual(readApiConfig("guideSlugs.lock.json"));
  });

  // The lock only pins catalog names (short ASCII); map slugs are computed
  // by both apps from free text, so the two slugifiers must agree on it.
  test("slug rule is identical to the API's (real map names and edge cases)", () => {
    const api = loadApiGuideSlugs();
    // ladder-map-pool.json is refreshed at runtime, so its list may vary;
    // the catalog names and edge cases keep the corpus non-empty.
    const mapNames = realMapNames();
    const displayNames = BUILD_DEFINITIONS.map((def) => guideDisplayName(def.name));
    for (const text of [...mapNames, ...displayNames, ...SLUG_EDGE_CASES]) {
      expect({ text, slug: guideSlugify(text) }).toEqual({
        text,
        slug: api.slugifyGuideText(text),
      });
      const apiSlug = api.mapSlug(text);
      expect(guideMapPath(text)).toBe(apiSlug ? `/guides/maps/${apiSlug}` : null);
    }
  });

  test("collision rule: matchup-prefixed keeps the plain slug", () => {
    expect(guideBuildSlug("ZvP", "ZvP - 2 Base Nydus")).toBe("2-base-nydus");
    expect(guideBuildSlug("ZvP", "Zerg - 2 Base Nydus")).toBe("zerg-2-base-nydus");
    expect(guideBuildSlug("TvT", "Terran - Widow Mine Drop")).toBe("widow-mine-drop");
    expect(guideStrategySlug("PvT", "Terran - Widow Mine Drop")).toBe(
      "terran-widow-mine-drop",
    );
  });

  test("perspective: PvX builds are PvX-only, counters vs Protoss are Protoss-only", () => {
    expect(guideBuildSlug("PvZ", "Protoss - DT Rush")).toBeNull();
    expect(guideStrategySlug("TvP", "Protoss - DT Rush")).toBe("dt-rush");
    expect(guideStrategySlug("TvP", "PvT - DT Drop")).toBeNull();
    expect(guideStrategySlug("PvZ", "ZvP - Ling Bane Bust")).toBe("ling-bane-bust");
    expect(guideBuildSlug("pvz", "PvZ - Stargate into Glaives")).toBeNull();
  });

  test("options list every namespace entry with its slug", () => {
    const builds = guideBuildOptions("PvZ");
    expect(builds.length).toBeGreaterThan(0);
    for (const { name, slug } of builds) expect(guideBuildSlug("PvZ", name)).toBe(slug);
    expect(guideStrategyOptions("ZvP").every((o) => o.name.startsWith("Protoss - "))).toBe(true);
    expect(guideBuildOptions("nope")).toEqual([]);
  });
});

describe("guide path helpers", () => {
  test("matchup paths and slugs", () => {
    expect(GUIDE_MATCHUPS).toHaveLength(9);
    expect(guideMatchupPath("PvZ")).toBe("/guides/pvz");
    for (const m of GUIDE_MATCHUPS) {
      expect(matchupFromGuideSlug(m.toLowerCase())).toBe(m);
      expect(isGuideMatchup(m)).toBe(true);
    }
    expect(matchupFromGuideSlug("PVZ")).toBeNull();
    expect(matchupFromGuideSlug("constructor")).toBeNull();
    expect(isGuideMatchup("PvR")).toBe(false);
  });

  test("build, counter and map paths", () => {
    expect(guideBuildPath("PvZ", "PvZ - Stargate into Glaives")).toBe(
      "/guides/pvz/stargate-into-glaives",
    );
    expect(guideBuildPath("ZvP", "Zerg - 2 Base Nydus")).toBe("/guides/zvp/zerg-2-base-nydus");
    expect(guideBuildPath("PvZ", "PvZ - Game Too Short")).toBeNull();
    expect(guideBuildPath("PvZ", "My custom build")).toBeNull();
    expect(guideCounterPath("PvZ", "Zerg - 12 Pool")).toBe("/guides/pvz/counter/12-pool");
    expect(guideCounterPath("PvZ", "PvZ - Stargate into Glaives")).toBeNull();
    expect(guideMapPath("Alcyone LE")).toBe("/guides/maps/alcyone-le");
    expect(guideMapPath("Pylône LE")).toBe("/guides/maps/pylone-le");
    expect(guideMapPath("아이어")).toBeNull();
  });

  test("display names and matchup-prefixed name parsing", () => {
    expect(guideDisplayName("PvZ - Stargate into Glaives")).toBe("Stargate into Glaives");
    expect(guideDisplayName("No separator")).toBe("No separator");
    expect(matchupFromBuildName("PvZ - Stargate into Glaives")).toBe("PvZ");
    expect(matchupFromBuildName("Zerg - 12 Pool")).toBeNull();
    expect(matchupFromBuildName("PvX - Something")).toBeNull();
    expect(matchupFromBuildName("Stargate")).toBeNull();
  });
});
