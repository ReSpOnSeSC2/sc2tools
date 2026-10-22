// @ts-nocheck
"use strict";

/**
 * scripts/refresh-ladder-map-pool.js — the weekly workflow's seed
 * refresher. Every run() here gets a stub fetch and a temp seed path,
 * so nothing reaches Liquipedia or touches data/ladder-map-pool.json.
 */

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { diffPools, run } = require("../scripts/refresh-ladder-map-pool");

const LIVE_WIKITEXT = `
{{Ladder maps display
|1v1_1=Alpha LE
|1v1_1text=blurb that must be ignored
|1v1_2=Bravo
|2v2_1=Team One
|4v4_1=Team Two
}}
`;

const SILENT = { info() {}, warn() {}, error() {}, child: () => SILENT };

function wikitextFetch(wikitext) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { parse: { wikitext: { "*": wikitext } } };
    },
  }));
}

async function writeSeed(seedPath, maps, teamMaps) {
  const raw = JSON.stringify({ maps, teamMaps, fetchedAt: 1, schemaVersion: 2 }, null, 2);
  await fs.writeFile(seedPath, raw, "utf8");
  return raw;
}

describe("diffPools", () => {
  test("reports added/removed per bucket", () => {
    const diff = diffPools(
      { maps: ["Alpha LE", "Old Map"], teamMaps: ["Team One"] },
      { maps: ["Alpha LE", "Bravo"], teamMaps: ["Team One", "Team Two"] },
    );
    expect(diff.changed).toBe(true);
    expect(diff.solo).toEqual({ added: ["Bravo"], removed: ["Old Map"] });
    expect(diff.team).toEqual({ added: ["Team Two"], removed: [] });
  });

  test("a reorder is not a change", () => {
    const diff = diffPools(
      { maps: ["Bravo", "Alpha LE"], teamMaps: ["Team Two", "Team One"] },
      { maps: ["Alpha LE", "Bravo"], teamMaps: ["Team One", "Team Two"] },
    );
    expect(diff.changed).toBe(false);
  });

  test("a missing seed counts every live map as added", () => {
    const diff = diffPools(null, { maps: ["Alpha LE"], teamMaps: [] });
    expect(diff.changed).toBe(true);
    expect(diff.solo.added).toEqual(["Alpha LE"]);
  });
});

describe("run", () => {
  let tmpDir;
  let seedPath;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "refresh-pool-test-"));
    seedPath = path.join(tmpDir, "seed.json");
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("rewrites the seed and summarises the rotation when the pool changed", async () => {
    await writeSeed(seedPath, ["Alpha LE", "Old Map"], ["Team One"]);
    const summaryPath = path.join(tmpDir, "summary.md");
    const out = await run({
      seedPath,
      summaryPath,
      fetchImpl: wikitextFetch(LIVE_WIKITEXT),
      logger: SILENT,
    });
    expect(out).toMatchObject({ code: 0, changed: true });
    const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
    expect(seed).toMatchObject({
      maps: ["Alpha LE", "Bravo"],
      teamMaps: ["Team One", "Team Two"],
      schemaVersion: 2,
    });
    expect(seed.fetchedAt).toBeGreaterThan(1);
    const summary = await fs.readFile(summaryPath, "utf8");
    expect(summary).toContain("- Added: Bravo");
    expect(summary).toContain("- Removed: Old Map");
    expect(summary).toContain("- Added: Team Two");
  });

  test("leaves the seed byte-identical when only the order differs", async () => {
    const before = await writeSeed(seedPath, ["Bravo", "Alpha LE"], ["Team Two", "Team One"]);
    const out = await run({ seedPath, fetchImpl: wikitextFetch(LIVE_WIKITEXT), logger: SILENT });
    expect(out).toMatchObject({ code: 0, changed: false });
    expect(out.summary).toContain("matches");
    expect(await fs.readFile(seedPath, "utf8")).toBe(before);
  });

  test("exits 1 without touching the seed when Liquipedia errors", async () => {
    const before = await writeSeed(seedPath, ["Alpha LE"], []);
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429 }));
    const out = await run({ seedPath, fetchImpl, logger: SILENT });
    expect(out.code).toBe(1);
    expect(await fs.readFile(seedPath, "utf8")).toBe(before);
  });

  test("exits 1 when the page parses to no 1v1 maps (template change)", async () => {
    const before = await writeSeed(seedPath, ["Alpha LE"], []);
    const teamOnly = "{{Ladder maps display\n|2v2_1=Team One\n}}";
    const out = await run({ seedPath, fetchImpl: wikitextFetch(teamOnly), logger: SILENT });
    expect(out.code).toBe(1);
    expect(await fs.readFile(seedPath, "utf8")).toBe(before);
  });
});
