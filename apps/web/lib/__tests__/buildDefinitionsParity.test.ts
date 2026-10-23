/**
 * /definitions must list every label the replay engine can emit. The
 * engine's catalog (apps/replay-engine/core/build_definitions.py) is read
 * straight from its source here, so a label added there without
 * `npm run definitions:gen` fails CI with the fix in the message. The
 * engine-side tests/test_build_definitions_export.py also checks the
 * generated file's descriptions.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILD_DEFINITIONS,
  ENGINE_DEFINITIONS,
  SUPPLEMENTARY_DEFINITIONS,
  filterDefinitions,
} from "@/lib/build-definitions";
import { DEFINITION_WORDING } from "@/lib/build-definitions/wording";
import { GUIDE_CATALOG_DEFINITIONS, GUIDE_PENDING_NAMES } from "@/lib/guides/catalog";
import { definitionGuideLinks } from "@/lib/guides/definitionLinks";
import {
  ENGINE_DEFINITIONS_FILE,
  buildGeneratedCatalog,
  labelRaceAndMatchup,
} from "@/scripts/gen-build-definitions.mjs";

const REGENERATE = "run `npm run definitions:gen` in apps/web";

/** The string keys of a top-level `NAME = { ... }` / `NAME: Dict[...] = { ... }` dict. */
function pythonDict(source: string, name: string): Map<string, string> {
  const start = source.search(new RegExp(`^${name}\\b[^=\\n]*=\\s*\\{`, "m"));
  if (start < 0) throw new Error(`${name} not found in build_definitions.py`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  const entries = new Map<string, string>();
  const entryRe = /^\s+"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/gm;
  for (const match of body.matchAll(entryRe)) {
    entries.set(JSON.parse(`"${match[1]}"`), JSON.parse(`"${match[2]}"`));
  }
  return entries;
}

const ENGINE_SOURCE = readFileSync(ENGINE_DEFINITIONS_FILE, "utf8");
const ENGINE_LABELS = pythonDict(ENGINE_SOURCE, "BUILD_DEFINITIONS");
const ENGINE_EIGHT_WORKER = pythonDict(ENGINE_SOURCE, "EIGHT_WORKER_BUILD_NAMES");
const WEB_NAMES = new Set(BUILD_DEFINITIONS.map((def) => def.name));

describe("engine ↔ /definitions parity", () => {
  it("reads the engine catalog", () => {
    expect(ENGINE_LABELS.size).toBeGreaterThan(150);
    expect(ENGINE_LABELS.has("Zerg - Hatch First")).toBe(true);
    expect(ENGINE_EIGHT_WORKER.get("Zerg - 12 Pool")).toBe("Zerg - 8 Pool");
  });

  it("lists every label the engine can emit", () => {
    const missing = [...ENGINE_LABELS.keys()].filter((name) => !WEB_NAMES.has(name));
    expect(missing, `engine labels missing from /definitions: ${REGENERATE}`).toEqual([]);
  });

  it("generated file matches the engine's label set exactly", () => {
    const generated = ENGINE_DEFINITIONS.map((def) => def.name).sort();
    expect(generated, `lib/build-definitions.generated.json is stale: ${REGENERATE}`).toEqual(
      [...ENGINE_LABELS.keys()].sort(),
    );
  });

  it("keeps each label's 8-worker patch name and finds it by search", () => {
    for (const [twelve, eight] of ENGINE_EIGHT_WORKER) {
      const def = BUILD_DEFINITIONS.find((d) => d.name === twelve);
      expect(def?.eightWorkerName, `${twelve}: ${REGENERATE}`).toBe(eight);
      expect(filterDefinitions(BUILD_DEFINITIONS, eight, "All", "All").map((d) => d.name)).toContain(twelve);
    }
  });

  it("wording overrides name live engine labels and add to the engine's text", () => {
    for (const [name, text] of Object.entries(DEFINITION_WORDING)) {
      expect(ENGINE_LABELS.has(name), `override for unknown label "${name}"`).toBe(true);
      const engineText = ENGINE_LABELS.get(name)?.trim();
      expect(text.trim(), `"${name}" override repeats the engine's text: delete it`).not.toBe(engineText);
      expect(BUILD_DEFINITIONS.find((d) => d.name === name)?.description).toBe(text);
    }
  });

  it("labels without an override show the engine's own description", () => {
    const bcRush = BUILD_DEFINITIONS.find((d) => d.name === "Terran - BC Rush");
    expect(bcRush?.description).toBe(ENGINE_LABELS.get("Terran - BC Rush")?.trim());
  });

  it("supplementary labels are the run-time ones the engine catalog lacks", () => {
    for (const def of SUPPLEMENTARY_DEFINITIONS) {
      expect(ENGINE_LABELS.has(def.name), def.name).toBe(false);
      expect(def.name).toMatch(/^[PTZ]v[PTZ] - Game Too Short$/);
      expect(labelRaceAndMatchup(def.name)).toEqual({ race: def.race, matchup: def.matchup });
    }
  });

  it("has unique ids and names, race-generic entries first in each race", () => {
    expect(new Set(BUILD_DEFINITIONS.map((d) => d.id)).size).toBe(BUILD_DEFINITIONS.length);
    expect(WEB_NAMES.size).toBe(BUILD_DEFINITIONS.length);
    const firstZerg = BUILD_DEFINITIONS.findIndex((d) => d.race === "Zerg");
    expect(BUILD_DEFINITIONS[firstZerg].matchup).toBeNull();
    const pvz = BUILD_DEFINITIONS.filter((d) => d.matchup === "PvZ").map((d) => d.name);
    // Catch-alls close their group, after every named build.
    expect(pvz.slice(-2)).toEqual([
      "PvZ - Game Too Short",
      "PvZ - Macro Transition (Unclassified)",
    ]);
  });
});

describe("gen-build-definitions", () => {
  it("derives race and matchup from the label prefix", () => {
    expect(labelRaceAndMatchup("PvZ - Stargate into Glaives")).toEqual({ race: "Protoss", matchup: "PvZ" });
    expect(labelRaceAndMatchup("Zerg - 12 Pool")).toEqual({ race: "Zerg", matchup: null });
    expect(labelRaceAndMatchup("TvP - 1-1-1 One Base")).toEqual({ race: "Terran", matchup: "TvP" });
    expect(() => labelRaceAndMatchup("Unclassified - Zerg")).toThrow(/must start with/);
  });

  it("sorts by name, attaches patch names and rejects bad exports", () => {
    const out = buildGeneratedCatalog({
      definitions: [
        { name: "Zerg - 12 Pool", description: " Early pool. " },
        { name: "PvZ - Robo Opener", description: "Robo first." },
      ],
      eightWorkerNames: { "Zerg - 12 Pool": "Zerg - 8 Pool" },
    });
    expect(out.definitions).toEqual([
      { name: "PvZ - Robo Opener", race: "Protoss", matchup: "PvZ", description: "Robo first." },
      { name: "Zerg - 12 Pool", race: "Zerg", matchup: null, description: "Early pool.", eightWorkerName: "Zerg - 8 Pool" },
    ]);
    expect(() => buildGeneratedCatalog({ definitions: [] })).toThrow(/no definitions/);
    expect(() =>
      buildGeneratedCatalog({
        definitions: [
          { name: "Zerg - 12 Pool", description: "a" },
          { name: "Zerg - 12 Pool", description: "b" },
        ],
      }),
    ).toThrow(/listed twice/);
    expect(() =>
      buildGeneratedCatalog({
        definitions: [{ name: "Zerg - 12 Pool", description: "a" }],
        eightWorkerNames: { "Zerg - 13 Pool": "Zerg - 9 Pool" },
      }),
    ).toThrow(/unknown label/);
  });
});

describe("guides and definitions", () => {
  it("labels pending a guide exist and stay out of the guide catalog", () => {
    for (const name of GUIDE_PENDING_NAMES) {
      expect(WEB_NAMES.has(name), name).toBe(true);
      expect(GUIDE_CATALOG_DEFINITIONS.some((d) => d.name === name), name).toBe(false);
    }
    expect(GUIDE_CATALOG_DEFINITIONS.length).toBe(BUILD_DEFINITIONS.length - GUIDE_PENDING_NAMES.size);
  });

  it("links only published guides, one per matchup a race label covers", () => {
    const defs = BUILD_DEFINITIONS.filter((d) =>
      ["PvZ - Stargate into Glaives", "Zerg - 12 Pool", "Protoss - Cannon Rush"].includes(d.name),
    );
    const published = new Set([
      "/guides/pvz/stargate-into-glaives",
      "/guides/zvp/12-pool",
      "/guides/zvt/12-pool",
    ]);
    const links = definitionGuideLinks(defs, published);
    expect(links["pvz-stargate-into-glaives"]).toEqual([
      { matchup: "PvZ", href: "/guides/pvz/stargate-into-glaives" },
    ]);
    expect(links["zerg-12-pool"]).toEqual([
      { matchup: "ZvP", href: "/guides/zvp/12-pool" },
      { matchup: "ZvT", href: "/guides/zvt/12-pool" },
    ]);
    expect(links["protoss-cannon-rush"]).toBeUndefined();
    expect(definitionGuideLinks(defs, null)).toEqual({});
  });
});
