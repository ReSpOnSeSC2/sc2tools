"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  LadderMapPoolService,
  parseCurrentMaps,
  FALLBACK_POOL,
} = require("../../src/services/ladderMapPool");

const SAMPLE_WIKITEXT = `
{{Infobox map collection}}

== Current Maps ==
{{MapList
|map=Equilibrium
|map=Goldenaura
|map=Hard Lead
|map=Oceanborn
|map=Site Delta
|map=El Dorado
|map=Whispers of Gold
|map=Pylon Overgrowth
|map=Frostline
}}

== Removed Maps ==
{{MapList
|map=Acropolis
|map=Disco Bloodbath
}}
`;

const SAMPLE_WIKITEXT_HEADING_VARIANT = `
==Current Map Pool==
{{MapDisplay|map=Atlas|year=2026}}
{{MapDisplay|map=Border|year=2026}}

== History ==
{{MapDisplay|map=Stale|year=2025}}
`;

function buildResponse(wikitext) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { parse: { wikitext: { "*": wikitext } } };
    },
  };
}

describe("parseCurrentMaps", () => {
  test("extracts map names from the Current Maps section only", () => {
    const out = parseCurrentMaps(SAMPLE_WIKITEXT);
    expect(out).toEqual([
      "Equilibrium",
      "Goldenaura",
      "Hard Lead",
      "Oceanborn",
      "Site Delta",
      "El Dorado",
      "Whispers of Gold",
      "Pylon Overgrowth",
      "Frostline",
    ]);
    expect(out).not.toContain("Acropolis"); // belongs to Removed Maps
  });

  test("recognises 'Current Map Pool' heading variant", () => {
    const out = parseCurrentMaps(SAMPLE_WIKITEXT_HEADING_VARIANT);
    expect(out).toEqual(["Atlas", "Border"]);
    expect(out).not.toContain("Stale");
  });

  test("returns [] for missing section / bogus input", () => {
    expect(parseCurrentMaps("")).toEqual([]);
    expect(parseCurrentMaps("just text, no template")).toEqual([]);
    // @ts-expect-error -- intentional bad input
    expect(parseCurrentMaps(null)).toEqual([]);
  });

  test("dedupes duplicate map entries preserving first-seen order", () => {
    const dup = `
== Current Maps ==
{{MapList|map=A|map=B|map=A|map=C}}
`;
    expect(parseCurrentMaps(dup)).toEqual(["A", "B", "C"]);
  });
});

describe("LadderMapPoolService — get/refresh", () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ladder-pool-"));
  });
  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  test("first get() fetches from Liquipedia and persists the result", async () => {
    const fetchImpl = jest.fn(async () => buildResponse(SAMPLE_WIKITEXT));
    const persistPath = path.join(tmpDir, "pool.json");
    const svc = new LadderMapPoolService({ fetchImpl, persistPath, now: () => 1_000 });
    const out = await svc.get();
    expect(out.source).toBe("liquipedia");
    expect(out.maps).toContain("Equilibrium");
    expect(out.maps).toContain("Frostline");
    // Persisted file has the same list.
    const persisted = JSON.parse(await fs.readFile(persistPath, "utf8"));
    expect(persisted.maps).toEqual(out.maps);
    expect(persisted.fetchedAt).toBe(1_000);
  });

  test("falls back to the persisted file when Liquipedia is unreachable", async () => {
    const persistPath = path.join(tmpDir, "pool.json");
    await fs.writeFile(
      persistPath,
      JSON.stringify({ maps: ["A", "B"], fetchedAt: 500, schemaVersion: 1 }),
    );
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });
    const svc = new LadderMapPoolService({ fetchImpl, persistPath });
    const out = await svc.get();
    expect(out.source).toBe("persisted");
    expect(out.maps).toEqual(["A", "B"]);
  });

  test("falls back to FALLBACK_POOL when both network and file are missing", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });
    const svc = new LadderMapPoolService({
      fetchImpl,
      persistPath: path.join(tmpDir, "does-not-exist.json"),
    });
    const out = await svc.get();
    expect(out.source).toBe("fallback");
    expect(out.maps).toEqual(FALLBACK_POOL.slice());
  });

  test("cache TTL serves the cached payload without re-fetching", async () => {
    const fetchImpl = jest.fn(async () => buildResponse(SAMPLE_WIKITEXT));
    const persistPath = path.join(tmpDir, "pool.json");
    let nowVal = 1_000;
    const svc = new LadderMapPoolService({
      fetchImpl,
      persistPath,
      now: () => nowVal,
    });
    await svc.get();
    await svc.get();
    nowVal += 60 * 60 * 1000; // 1h later
    await svc.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("refresh({ force: true }) reports added/removed diff", async () => {
    const first = SAMPLE_WIKITEXT;
    const second = `== Current Maps ==\n{{MapList|map=Equilibrium|map=Goldenaura|map=NewMap}}\n== Old ==\n`;
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call++;
      return buildResponse(call === 1 ? first : second);
    });
    const svc = new LadderMapPoolService({
      fetchImpl,
      persistPath: path.join(tmpDir, "pool.json"),
    });
    await svc.get();
    const diff = await svc.refresh({ force: true });
    expect(diff.added).toContain("NewMap");
    expect(diff.removed).toContain("Frostline");
  });

  test("malformed persisted file is ignored (falls through to fallback)", async () => {
    const persistPath = path.join(tmpDir, "pool.json");
    await fs.writeFile(persistPath, "{not json");
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });
    const svc = new LadderMapPoolService({ fetchImpl, persistPath });
    const out = await svc.get();
    expect(out.source).toBe("fallback");
  });

  test("concurrent get() calls only fire one network request", async () => {
    let resolveFetch;
    const pending = new Promise((r) => {
      resolveFetch = r;
    });
    const fetchImpl = jest.fn(async () => {
      await pending;
      return buildResponse(SAMPLE_WIKITEXT);
    });
    const svc = new LadderMapPoolService({
      fetchImpl,
      persistPath: path.join(tmpDir, "pool.json"),
    });
    const a = svc.get();
    const b = svc.get();
    resolveFetch();
    await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
