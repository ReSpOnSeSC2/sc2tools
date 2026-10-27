import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandGuideQueryMatchup, createCommandGuideCatalog, isCommandGuidePath,
} from "../commandGuideSearch";
import { searchCommands } from "../commandSearch";
import { guideCounterPath, guideMapPath } from "../guides/slugs";

const poolPath = guideCounterPath("PvZ", "Zerg - 12 Pool")!;
afterEach(() => vi.unstubAllGlobals());

describe("published public guide search", () => {
  it.each(["12pool", "12 pool", "beat 12 pool", "how to beat12pool"])(
    "finds the real 12 Pool counter under How to beat for %s", query => {
      expect(poolPath).toBe("/guides/pvz/counter/12-pool");
      const catalog = createCommandGuideCatalog({ publishedPaths: new Set([poolPath]) });
      const groups = searchCommands(catalog, `${query} pvz`, ["guide-counters"]);
      expect(groups[0].label).toBe("How to beat");
      expect(groups[0].items.find(row => row.label === "12 Pool")).toMatchObject({
        href: poolPath, matchup: "PvZ", disabled: false,
      });
    },
  );

  it("keeps unpublished matches visible, disabled and unlinked", () => {
    const catalog = createCommandGuideCatalog({ publishedPaths: new Set() });
    const row = catalog.find(candidate => candidate.id === `guide:${poolPath}`);
    expect(row).toMatchObject({ disabled: true, description: "Not enough games yet" });
    expect(row?.href).toBeUndefined();
    expect(searchCommands(catalog, "12 pool pvz").flatMap(group => group.items)).toContain(row);
  });

  it("distinguishes unavailable publication metadata from a known unpublished catalog", () => {
    const catalog = createCommandGuideCatalog({ publishedPaths: null });
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every(row => row.disabled && row.href === undefined)).toBe(true);
    expect(catalog.every(row => row.description === "Guide availability unavailable")).toBe(true);
  });

  it("links only exact positive candidates, ignoring foreign/private/query/hash paths", () => {
    const publishedPaths = new Set([
      poolPath, `${poolPath}?token=secret`, `${poolPath}#fragment`,
      "https://foreign.test/guides/pvz/counter/12-pool", "/admin", "/guides/pvz/not-in-the-catalog",
    ]);
    const linked = createCommandGuideCatalog({ publishedPaths }).filter(row => row.href);
    expect(linked.map(row => row.href)).toEqual([poolPath]);
    const decorated = new Set([`${poolPath}?token=secret`, `${poolPath}#fragment`]);
    expect(createCommandGuideCatalog({ publishedPaths: decorated }).some(row => row.href)).toBe(false);
  });

  it.each([["pvz", "PvZ"], ["protoss vs zerg", "PvZ"], ["zvp", "ZvP"], ["zerg vs protoss", "ZvP"]])(
    "preserves viewer matchup direction for %s", (query, matchup) => {
      expect(commandGuideQueryMatchup(query)).toBe(matchup);
      const catalog = createCommandGuideCatalog({ publishedPaths: null });
      const groups = searchCommands(catalog, query, ["guide-openers", "guide-counters"]);
      const rows = groups.flatMap(group => group.items);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.matchup === matchup)).toBe(true);
    },
  );
});

describe("public guide map metadata", () => {
  it("projects only map names/canonical slugs and requires the same publication gate", () => {
    const maps = [
      { map: "Alcyone LE", slug: "alcyone-le", playerName: "DO NOT INDEX ME" },
      { map: "Other LE", slug: "other-le", playerName: "DO NOT INDEX ME" },
    ];
    const catalog = createCommandGuideCatalog({ maps, publishedPaths: new Set(["/guides/maps/alcyone-le"]) });
    const rows = catalog.filter(row => row.group === "guide-maps");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "Alcyone LE", href: "/guides/maps/alcyone-le", disabled: false });
    expect(rows[1]).toMatchObject({ label: "Other LE", disabled: true });
    expect(rows[1].href).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("DO NOT INDEX ME");
  });

  it("rejects duplicate/noncanonical/malformed maps instead of constructing candidate links", () => {
    const maps = [
      { map: "Alcyone LE", slug: "alcyone-le" }, { map: "Alcyone LE", slug: "alcyone-le" },
      { map: "Alcyone LE", slug: "//foreign.test" }, { map: "Bad\nName", slug: "bad-name" },
      { map: " ", slug: "empty" }, { map: "a".repeat(201), slug: "a".repeat(80) },
    ];
    const rows = createCommandGuideCatalog({ maps, publishedPaths: null }).filter(row => row.group === "guide-maps");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Alcyone LE", disabled: true });
    expect(rows[0].href).toBeUndefined();
  });

  it("caps map metadata at 200 rows and returns unique stable candidate identities", () => {
    const maps = Array.from({ length: 201 }, (_, index) => ({ map: `Map ${index} LE`, slug: `map-${index}-le` }));
    const publishedPaths = new Set(maps.flatMap(map => guideMapPath(map.map) ?? []));
    const catalog = createCommandGuideCatalog({ maps, publishedPaths });
    expect(catalog.filter(row => row.group === "guide-maps")).toHaveLength(200);
    expect(new Set(catalog.map(row => row.id)).size).toBe(catalog.length);
  });

  it("never fetches a guide, personal stats or a private corpus while searching", () => {
    const fetch = vi.fn(() => { throw new Error("Guide search is local"); });
    vi.stubGlobal("fetch", fetch);
    const catalog = createCommandGuideCatalog({ publishedPaths: null });
    searchCommands(catalog, "12pool");
    searchCommands(catalog, "pvt");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("canonical guide candidate paths", () => {
  it.each(["/guides", "/guides/pvz", "/guides/pvz/counter/12-pool", "/guides/maps/alcyone-le"])(
    "accepts %s", path => expect(isCommandGuidePath(path)).toBe(true),
  );
  it.each([
    "//foreign.test/guides/pvz", "https://foreign.test/guides/pvz", "/guides/pvz?band=league:4",
    "/guides/pvz#secret", "/guides/pvz/../admin", "/guides/PvZ", `/guides/maps/${"a".repeat(81)}`,
    "/guides/pvz/counter/12-pool\n",
  ])("rejects %s", path => expect(isCommandGuidePath(path)).toBe(false));
});
