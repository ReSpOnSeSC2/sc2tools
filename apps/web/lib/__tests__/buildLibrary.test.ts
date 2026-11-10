import { describe, expect, it } from "vitest";
import {
  SHARE_CODE_MAX_CHARS,
  authorUpdated,
  clientValidateBuild,
  communityVersionsPath,
  decodeShareCode,
  encodeShareCode,
  normalizeTags,
  parseImportSource,
  shareImportHref,
} from "../buildLibrary";
import { diffBuildFields, diffRules } from "../buildLibraryDiff";
import { addBuildsToPool } from "../randomizer/addToPool";
import { defaultRandomizerConfig } from "../randomizer/config";

const build = {
  slug: "pvz-stargate",
  name: "PvZ Stargate",
  race: "Protoss",
  vsRace: "Zerg",
  notes: "private scouting notes",
  isPublic: true,
  tags: ["Macro"],
  rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
};

function base64url(text: string) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("share codes", () => {
  it("round-trips a build's definition without notes, tags or publication state", () => {
    const code = encodeShareCode(build);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(shareImportHref(code)).toBe(`/builds/import#code=${code}`);
    const decoded = decodeShareCode(`https://sc2tools.com${shareImportHref(code)}`);
    expect(decoded).toEqual({
      ok: true,
      build: expect.objectContaining({ name: "PvZ Stargate", race: "Protoss", vsRace: "Zerg", rules: [expect.objectContaining({ name: "BuildStargate", time_lt: 240 })] }),
    });
    if (!decoded.ok) throw new Error("expected a build");
    expect(decoded.build).not.toHaveProperty("notes");
    expect(decoded.build).not.toHaveProperty("isPublic");
    expect(decoded.build).not.toHaveProperty("tags");
  });

  it("refuses builds over 8 KB and hostile input", () => {
    expect(() => encodeShareCode({ ...build, description: "x".repeat(SHARE_CODE_MAX_CHARS) })).toThrow("share_code_too_large");
    const refused = [
      "",
      "a".repeat(SHARE_CODE_MAX_CHARS + 1),
      "not a code!",
      "%%%",
      base64url("ÿþ"), // not UTF-8 once decoded as bytes
      base64url("{not json"),
      base64url(JSON.stringify({ v: 2, b: { name: "x", race: "Zerg" } })),
      base64url(JSON.stringify({ v: 1, b: ["array"] })),
      base64url(JSON.stringify({ v: 1, b: { name: "Bad", race: "Elf" } })),
      base64url(JSON.stringify({ v: 1, b: { name: "", race: "Zerg" } })),
      base64url(JSON.stringify({ v: 1, b: { name: "Many", race: "Zerg", rules: Array.from({ length: 31 }, () => ({ type: "before", name: "BuildHatchery", time_lt: 60 })) } })),
    ];
    for (const input of refused) expect(decodeShareCode(input).ok).toBe(false);
  });
});

describe("import sources and validation", () => {
  it("reads an export file, an array, one build or a share code, validating each build", () => {
    const exported = parseImportSource(JSON.stringify({ format: "sc2tools-custom-builds", version: 1, builds: [build, { name: "Bad", race: "Elf" }] }));
    expect(exported.candidates.map((candidate) => !!candidate.build)).toEqual([true, false]);
    expect(exported.candidates[1].errors?.[0]).toMatch(/Race must be/);
    expect(exported.candidates[0].build).not.toHaveProperty("isPublic");
    expect(parseImportSource(JSON.stringify([build])).candidates).toHaveLength(1);
    expect(parseImportSource(JSON.stringify(build)).candidates[0].label).toBe("PvZ Stargate");
    expect(parseImportSource(encodeShareCode(build)).candidates[0].label).toBe("PvZ Stargate");
    expect(parseImportSource("{oops").error).toMatch(/valid JSON/);
    expect(parseImportSource("").error).toBeTruthy();
    expect(parseImportSource(JSON.stringify(Array.from({ length: 501 }, () => build))).error).toMatch(/500/);
    // Anything that isn't JSON is read as a share code, and refused as one.
    expect(parseImportSource(JSON.stringify("text")).candidates[0].errors?.[0]).toMatch(/share code/);
  });

  it("keeps only accepted fields with their bounds", () => {
    const result = clientValidateBuild({ ...build, slug: "bad slug!", userId: "someone", skillLevel: "legend", winConditions: ["  ", "Take map control"], pinned: "yes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.build).toEqual({
      name: "PvZ Stargate", race: "Protoss", vsRace: "Zerg", notes: "private scouting notes",
      rules: [expect.objectContaining({ name: "BuildStargate" })], schemaVersion: 3,
      winConditions: ["Take map control"], tags: ["Macro"],
    });
    expect(clientValidateBuild(Object.create({ name: "x" })).ok).toBe(false);
    expect(clientValidateBuild({ name: "x".repeat(121), race: "Zerg" }).ok).toBe(false);
  });

  it("normalises tags", () => {
    expect(normalizeTags([" Cheese ", "cheese", "", "ZvP  macro", 4, "x".repeat(30)])).toEqual(["Cheese", "ZvP macro", "x".repeat(24)]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, n) => `t${n}`))).toHaveLength(8);
    expect(normalizeTags("nope")).toEqual([]);
  });
});

describe("author updates", () => {
  const current = { slug: "pub", version: 3, updatedAt: "2026-11-01T00:00:00.000Z" };
  it("compares the saved version, or the saved time for older copies", () => {
    expect(authorUpdated({ communitySlug: "pub", version: "2" }, current)).toBe(true);
    expect(authorUpdated({ communitySlug: "pub", version: "3" }, current)).toBe(false);
    expect(authorUpdated({ communitySlug: "pub", version: "2026-10-01T00:00:00.000Z" }, current)).toBe(true);
    expect(authorUpdated({ communitySlug: "pub", version: "2026-11-01T00:00:00.500Z" }, current)).toBe(false);
    expect(authorUpdated({ communitySlug: "pub", version: null, savedAt: "2026-10-15T00:00:00.000Z" }, current)).toBe(true);
    expect(authorUpdated(null, current)).toBe(false);
    expect(authorUpdated({ communitySlug: "pub", version: "1" }, undefined)).toBe(false);
  });

  it("batches distinct valid slugs into one versions request", () => {
    expect(communityVersionsPath(["b", "a", "a", null, "bad/slug"])).toBe("/v1/community/builds/versions?slugs=a,b");
    expect(communityVersionsPath([undefined])).toBeNull();
  });

  it("diffs rules and plain fields", () => {
    const rows = diffRules(
      [{ type: "before", name: "BuildStargate", time_lt: 240 }, { type: "before", name: "BuildForge", time_lt: 200 }],
      [{ type: "before", name: "BuildStargate", time_lt: 210 }, { type: "count_min", name: "BuildGateway", time_lt: 300, count: 2 }],
    );
    expect(rows.map((row) => row.kind)).toEqual(["changed", "added", "removed"]);
    expect(diffRules([{ type: "before", name: "BuildForge", time_lt: 200 }], [{ type: "before", name: "BuildForge", time_lt: 200 }])[0].kind).toBe("same");
    expect(diffBuildFields({ name: "A", notes: "x" }, { name: "B", notes: "x" })).toEqual([{ field: "name", label: "Name", before: "A", after: "B" }]);
  });
});

describe("randomizer pool", () => {
  it("adds builds to every pool they fit once and skips opponent captures", () => {
    const builds = [
      { slug: "any", name: "Any Protoss", race: "Protoss", vsRace: "Any" },
      { slug: "pvz", name: "Only PvZ", race: "Protoss", vsRace: "Zerg" },
      { slug: "opp", name: "Opponent", race: "Protoss", vsRace: "Zerg", perspective: "opponent" },
    ];
    const first = addBuildsToPool(defaultRandomizerConfig(), builds);
    expect(first.matchups).toEqual(["PvP", "PvT", "PvZ"]);
    expect(first.added).toBe(4);
    expect(first.config.matchups.PvZ.builds.map((entry) => entry.id)).toEqual(["custom:any", "custom:pvz"]);
    expect(first.config.matchups.PvZ.builds[0].openingUnits).toBeTruthy();
    expect(addBuildsToPool(first.config, builds)).toEqual(expect.objectContaining({ added: 0, matchups: [] }));
  });
});
