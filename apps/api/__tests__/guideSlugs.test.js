"use strict";

const LOCK = require("../src/config/guideSlugs.lock.json");
const CATALOG = require("../src/config/guideCatalog.json");
const slugs = require("../src/config/guideSlugs");

const {
  MATCHUPS,
  RACE_WORDS,
  SLUG_ALIASES,
  SLUG_MAX_CHARS,
  buildNamesForMatchup,
  buildSlug,
  catalogEntry,
  displayName,
  guideSlugTable,
  isGuideBuildName,
  isGuideStrategyName,
  mapSlug,
  matchupFromSlug,
  matchupSlug,
  resolveBuild,
  resolveStrategy,
  slugifyGuideText,
  strategyNamesForMatchup,
  strategySlug,
  validateSlugAliases,
} = slugs;

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_SIZE_FLOOR = 150;
/** Contract §2: names that are never openers, whatever their catalog id. */
const NON_OPENER_NAME_PATTERNS = [/Comp$/, /\(Unclassified\)$/, /^Unclassified\b/, /Game Too Short$/];
/**
 * URL segments a build slug must never take: `/guides/<mu>/counter` is the
 * counter list page, so a build slugged "counter" would be unreachable.
 */
const RESERVED_BUILD_SLUGS = ["counter"];

/**
 * Owning race implied by a catalog name's prefix ("PvZ - …" / "Protoss - …").
 *
 * @param {string} name
 * @returns {string|undefined}
 */
function raceOfName(name) {
  const prefix = name.slice(0, name.indexOf(" - "));
  return RACE_WORDS[prefix[0]];
}

/**
 * Namespaces an opener belongs to, derived independently from the
 * perspective rules (user builds vs opponent strategies).
 *
 * @param {string} name
 * @returns {{ builds: string[], counters: string[] }}
 */
function expectedNamespaces(name) {
  const prefix = name.slice(0, name.indexOf(" - "));
  /** @type {{ builds: string[], counters: string[] }} */
  const out = { builds: [], counters: [] };
  for (const matchup of MATCHUPS) {
    const [mine, , theirs] = matchup;
    const mineWord = RACE_WORDS[mine];
    const theirWord = RACE_WORDS[theirs];
    if (prefix === matchup || (prefix === mineWord && mine !== "P")) out.builds.push(matchup);
    if ((prefix === `${theirs}v${mine}` && theirs !== "P") || prefix === theirWord) out.counters.push(matchup);
  }
  return out;
}

describe("config/guideSlugs catalog and lock", () => {
  test("catalog JSON is sorted, unique and well-formed", () => {
    expect(CATALOG.length).toBeGreaterThan(CATALOG_SIZE_FLOOR);
    const names = CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    for (const entry of CATALOG) {
      expect(Object.keys(entry)).toEqual(["name", "race", "matchup", "description", "opener"]);
      expect(entry.name).toContain(" - ");
      if (entry.matchup !== null) expect(entry.name.startsWith(`${entry.matchup} - `)).toBe(true);
    }
  });

  // The web drift test (lib/guides/__tests__/slugs.test.ts) only runs in web
  // CI; these invariants catch a hand edit of the JSON in API-only changes.
  test("catalog rows are internally consistent (race, matchup, opener flag)", () => {
    for (const entry of CATALOG) {
      const prefix = entry.name.slice(0, entry.name.indexOf(" - "));
      expect({ name: entry.name, race: entry.race }).toEqual({ name: entry.name, race: raceOfName(entry.name) });
      expect({ name: entry.name, matchup: entry.matchup })
        .toEqual({ name: entry.name, matchup: MATCHUPS.includes(prefix) ? prefix : null });
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.opener).toBe("boolean");
      if (NON_OPENER_NAME_PATTERNS.some((re) => re.test(entry.name))) {
        expect({ name: entry.name, opener: entry.opener }).toEqual({ name: entry.name, opener: false });
      }
    }
    expect(catalogEntry("Terran - SkyTerran")).toEqual(expect.objectContaining({ opener: false }));
    expect(catalogEntry("Protoss - Skytoss Transition")).toEqual(expect.objectContaining({ opener: false }));
  });

  test("live mapping deep-equals the committed lock (renames cannot silently break URLs)", () => {
    expect(guideSlugTable()).toEqual(LOCK);
  });

  test("slugs are unique and well-formed in every namespace", () => {
    const table = guideSlugTable();
    for (const kind of /** @type {const} */ (["builds", "counters"])) {
      expect(Object.keys(table[kind])).toEqual(MATCHUPS.map((m) => m.toLowerCase()));
      for (const ns of Object.values(table[kind])) {
        const names = Object.values(ns);
        expect(new Set(names).size).toBe(names.length);
        for (const slug of Object.keys(ns)) {
          expect(slug).toMatch(SLUG_SHAPE);
          expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
        }
      }
    }
    for (const ns of Object.values(table.builds)) {
      for (const reserved of RESERVED_BUILD_SLUGS) expect(Object.hasOwn(ns, reserved)).toBe(false);
    }
  });
});

describe("config/guideSlugs namespaces", () => {
  test("every opener sits in exactly the namespaces its perspective allows; non-openers in none", () => {
    for (const entry of CATALOG) {
      const want = entry.opener ? expectedNamespaces(entry.name) : { builds: [], counters: [] };
      const gotBuilds = MATCHUPS.filter((m) => buildNamesForMatchup(m).includes(entry.name));
      const gotCounters = MATCHUPS.filter((m) => strategyNamesForMatchup(m).includes(entry.name));
      expect({ name: entry.name, builds: gotBuilds, counters: gotCounters })
        .toEqual({ name: entry.name, ...want });
      if (entry.opener) expect(gotBuilds.length + gotCounters.length).toBeGreaterThan(0);
    }
  });

  test("Protoss asymmetry: PvX builds are PvX-only, counters vs Protoss are race-generic only", () => {
    for (const m of ["PvP", "PvT", "PvZ"]) {
      expect(buildNamesForMatchup(m).every((n) => n.startsWith(`${m} - `))).toBe(true);
    }
    for (const m of ["PvP", "TvP", "ZvP"]) {
      expect(strategyNamesForMatchup(m).every((n) => n.startsWith("Protoss - "))).toBe(true);
    }
    expect(strategyNamesForMatchup("PvZ")).toEqual(buildNamesForMatchup("ZvP"));
    expect(strategyNamesForMatchup("TvZ")).toEqual(buildNamesForMatchup("ZvT"));
  });

  test("collisions: matchup-prefixed name keeps the plain slug, race-generic gets <race>-<slug>", () => {
    expect(buildSlug("ZvP", "ZvP - 2 Base Nydus")).toBe("2-base-nydus");
    expect(buildSlug("ZvP", "Zerg - 2 Base Nydus")).toBe("zerg-2-base-nydus");
    expect(buildSlug("ZvP", "Zerg - 2 Base Roach/Ravager All-in")).toBe("zerg-2-base-roach-ravager-all-in");
    expect(buildSlug("ZvT", "Zerg - 2 Base Nydus")).toBe("zerg-2-base-nydus");
    expect(buildSlug("TvP", "TvP - Widow Mine Drop")).toBe("widow-mine-drop");
    expect(buildSlug("TvP", "Terran - Widow Mine Drop")).toBe("terran-widow-mine-drop");
    // No collision in TvT, so the race-generic name keeps its plain slug there.
    expect(buildSlug("TvT", "Terran - Widow Mine Drop")).toBe("widow-mine-drop");
    expect(strategySlug("PvZ", "Zerg - 2 Base Nydus")).toBe("zerg-2-base-nydus");
    expect(strategySlug("PvT", "Terran - Widow Mine Drop")).toBe("terran-widow-mine-drop");
  });
});

describe("config/guideSlugs name lookups", () => {
  test("buildSlug / strategySlug / isGuide*Name reject names outside the namespace", () => {
    expect(buildSlug("PvZ", "PvZ - Stargate into Glaives")).toBe("stargate-into-glaives");
    expect(buildSlug("PvT", "PvZ - Stargate into Glaives")).toBeNull();
    expect(buildSlug("PvZ", "Protoss - DT Rush")).toBeNull();
    expect(buildSlug("PvZ", "PvZ - Game Too Short")).toBeNull();
    expect(buildSlug("PvX", "PvZ - Stargate into Glaives")).toBeNull();
    expect(isGuideBuildName("ZvP", "Zerg - 8 Pool")).toBe(true);
    expect(isGuideBuildName("ZvP", "Zerg - Hatch First")).toBe(false);
    expect(isGuideBuildName("PvZ", "PvZ - Macro Transition (Unclassified)")).toBe(false);
    expect(isGuideBuildName("PvZ", "My custom build")).toBe(false);
    expect(isGuideBuildName("PvZ", 42)).toBe(false);
    expect(isGuideStrategyName("PvZ", "ZvP - Ling Bane Bust")).toBe(true);
    expect(isGuideStrategyName("PvZ", "Terran - Proxy Rax")).toBe(false);
    expect(isGuideStrategyName("TvP", "Protoss - DT Rush")).toBe(true);
    expect(isGuideStrategyName("TvP", "PvT - DT Drop")).toBe(false);
    expect(isGuideStrategyName("TvP", "Protoss - Robo Comp")).toBe(false);
    expect(buildNamesForMatchup("__proto__")).toEqual([]);
    expect(strategyNamesForMatchup("pvz")).toEqual([]);
  });

  test("namespace name lists are frozen", () => {
    expect(Object.isFrozen(buildNamesForMatchup("PvZ"))).toBe(true);
    expect(Object.isFrozen(buildNamesForMatchup("nope"))).toBe(true);
  });
});

describe("config/guideSlugs matchups and resolution", () => {
  test("matchupSlug / matchupFromSlug round-trip and reject junk", () => {
    expect(MATCHUPS).toHaveLength(9);
    for (const m of MATCHUPS) {
      expect(matchupFromSlug(matchupSlug(m))).toBe(m);
    }
    expect(matchupSlug("PvZ")).toBe("pvz");
    expect(matchupSlug("pvz")).toBeNull();
    expect(matchupSlug("PvR")).toBeNull();
    for (const junk of ["PvZ", "PVZ", "pv", "pvr", "", " pvz", "pvz/", "__proto__", "constructor", null, undefined, 7, {}]) {
      expect(matchupFromSlug(junk)).toBeNull();
    }
  });

  test("resolveBuild / resolveStrategy return the live entry", () => {
    expect(resolveBuild("pvz", "stargate-into-glaives")).toEqual({
      matchup: "PvZ", name: "PvZ - Stargate into Glaives", slug: "stargate-into-glaives",
    });
    expect(resolveBuild("zvp", "zerg-2-base-nydus")).toEqual({
      matchup: "ZvP", name: "Zerg - 2 Base Nydus", slug: "zerg-2-base-nydus",
    });
    expect(resolveStrategy("pvz", "ling-bane-bust")).toEqual({
      matchup: "PvZ", name: "ZvP - Ling Bane Bust", slug: "ling-bane-bust",
    });
    expect(resolveStrategy("tvp", "dt-rush")).toEqual({
      matchup: "TvP", name: "Protoss - DT Rush", slug: "dt-rush",
    });
  });

  test("resolve rejects unknown, non-canonical and hostile input", () => {
    expect(resolveBuild("pvz", "does-not-exist")).toBeNull();
    expect(resolveBuild("PvZ", "stargate-into-glaives")).toBeNull();
    expect(resolveBuild("pvz", "Stargate-Into-Glaives")).toBeNull();
    expect(resolveBuild("pvt", "stargate-into-robo")).toBeNull();
    expect(resolveBuild("pvz", "game-too-short")).toBeNull();
    expect(resolveBuild("pvz", "__proto__")).toBeNull();
    expect(resolveBuild("__proto__", "x")).toBeNull();
    expect(resolveBuild(undefined, undefined)).toBeNull();
    expect(resolveStrategy("pvz", "stargate-into-glaives")).toBeNull();
  });
});

describe("config/guideSlugs aliases", () => {
  test("SLUG_ALIASES ships empty and valid", () => {
    expect(SLUG_ALIASES).toEqual({ builds: {}, counters: {} });
    expect(Object.isFrozen(SLUG_ALIASES)).toBe(true);
    expect(validateSlugAliases(SLUG_ALIASES)).toEqual([]);
  });

  test("an aliased (retired) slug resolves to a redirect to the live slug", () => {
    const builds = { pvz: { "old-glaives": "stargate-into-glaives", "old-gone": "no-such-slug" } };
    expect(resolveBuild("pvz", "old-glaives", builds)).toEqual({
      redirect: { matchupSlug: "pvz", slug: "stargate-into-glaives" },
    });
    // Live slugs win over aliases; dangling aliases and other matchups resolve to nothing.
    expect(resolveBuild("pvz", "stargate-into-glaives", builds)).toEqual(
      expect.objectContaining({ slug: "stargate-into-glaives" }),
    );
    expect(resolveBuild("pvz", "old-gone", builds)).toBeNull();
    expect(resolveBuild("pvt", "old-glaives", builds)).toBeNull();
    expect(resolveBuild("pvz", "toString", builds)).toBeNull();
    const counters = { pvz: { "old-nydus": "zerg-2-base-nydus" } };
    expect(resolveStrategy("pvz", "old-nydus", counters)).toEqual({
      redirect: { matchupSlug: "pvz", slug: "zerg-2-base-nydus" },
    });
    // The default alias table is the (empty) shipped one.
    expect(resolveBuild("pvz", "old-glaives")).toBeNull();
  });

  test("validateSlugAliases flags unknown matchups, shadowed and dangling aliases", () => {
    const problems = validateSlugAliases({
      builds: { pvz: { "stargate-into-glaives": "robo-opener", "old": "nope" }, pvx: { a: "b" } },
      counters: {},
    });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/is a live slug/);
    expect(problems.join("\n")).toMatch(/"nope" is not a live slug/);
    expect(problems.join("\n")).toMatch(/unknown matchup slug "pvx"/);
  });
});

describe("config/guideSlugs catalog rows, display names and map slugs", () => {
  test("catalogEntry returns the frozen catalog row or null", () => {
    const entry = catalogEntry("Zerg - 8 Pool");
    expect(entry).toEqual(expect.objectContaining({ name: "Zerg - 8 Pool", race: "Zerg", matchup: null, opener: true }));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(catalogEntry("PvZ - Game Too Short")).toEqual(expect.objectContaining({ opener: false }));
    expect(catalogEntry("Zerg - Hatch First")).toBeNull();
    expect(catalogEntry(undefined)).toBeNull();
  });

  test("displayName strips the prefix up to the first separator only", () => {
    expect(displayName("PvZ - Stargate into Glaives")).toBe("Stargate into Glaives");
    expect(displayName("Zerg - 2 Base Roach/Ravager All-in")).toBe("2 Base Roach/Ravager All-in");
    expect(displayName("A - B - C")).toBe("B - C");
    expect(displayName("No separator")).toBe("No separator");
    expect(displayName(null)).toBe("");
  });

  test("mapSlug slugs the full map name", () => {
    expect(mapSlug("Alcyone LE")).toBe("alcyone-le");
    expect(mapSlug("  Ghost River LE ")).toBe("ghost-river-le");
    expect(mapSlug("2000 Atmospheres LE")).toBe("2000-atmospheres-le");
    expect(mapSlug("Pylône LE")).toBe("pylone-le");
    expect(mapSlug("아이어")).toBeNull();
    expect(mapSlug("")).toBeNull();
    expect(mapSlug(null)).toBeNull();
    expect(mapSlug("x".repeat(SLUG_MAX_CHARS + 20))).toHaveLength(SLUG_MAX_CHARS);
  });

  test("slugifyGuideText never ends on a hyphen after truncation", () => {
    const text = `${"a".repeat(SLUG_MAX_CHARS - 1)} b`;
    expect(slugifyGuideText(text)).toBe("a".repeat(SLUG_MAX_CHARS - 1));
  });
});
