// @ts-nocheck
"use strict";

/**
 * The pure public-payload shapers (services/guidesPayloads.js,
 * services/guidesPagePayloads.js) re-check the floors at serve time and
 * copy fields by allowlist. These cases feed them hand-made guide_stats
 * docs a writer bug or a hand edit could produce — below-floor groups, a
 * ``published`` flag that disagrees with the numbers, unsorted rows, stray
 * identity fields — and assert none of it is served. TEST FIXTURES ONLY.
 */

const {
  pickCell,
  shapeIndexPayload,
  shapeMatchupPayload,
} = require("../src/services/guidesPayloads");
const {
  shapeBuildPayload,
  shapeCounterPayload,
  shapeMapPayload,
  shapeSitemapPayload,
} = require("../src/services/guidesPagePayloads");

const GLAIVES = "PvZ - Stargate into Glaives";
const ROBO = "PvZ - Robo Opener";
const CARRIER = "PvZ - Carrier Rush";
const EIGHT_POOL = "Zerg - 8 Pool";
const AT = new Date("2026-09-20T00:00:00Z");

/** A floor-clearing cell with an explicit Wilson lower bound. */
const cell = (games, users, low, extra = {}) => ({
  games, users, wins: Math.round(games / 2), winRate: 0.5, ci: { low, high: low + 0.1 }, ...extra,
});

/** Every numeric leaf of a JSON value (deep). */
function deepNumbers(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => deepNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => deepNumbers(v, out));
  return out;
}

function buildInput(doc) {
  return {
    matchup: "PvZ", buildKey: GLAIVES, buildSlug: "stargate-into-glaives", era: "after", doc,
    matchupDoc: null, videos: [], communityBuilds: [], examples: [], notes: null,
  };
}

describe("pickCell", () => {
  test.each([
    ["games below the floor", cell(29, 9, 0.4)],
    ["users below the floor", cell(300, 4, 0.4)],
    ["no ci", { games: 40, users: 6, wins: 20, winRate: 0.5 }],
    ["a string count", { ...cell(40, 6, 0.4), games: "40" }],
    ["not an object", 42],
  ])("drops %s", (_label, raw) => {
    expect(pickCell(raw)).toBeNull();
  });

  test("copies exactly the Cell fields", () => {
    const raw = cell(40, 6, 0.4, { userId: "u_leak", key: "build:x", baseline: { games: 1 } });
    expect(pickCell(raw)).toEqual({ games: 40, users: 6, wins: 20, winRate: 0.5, ci: { low: 0.4, high: 0.5 } });
  });
});

describe("shapeBuildPayload", () => {
  const publishedDoc = () => ({
    kind: "build", key: "build:after:PvZ:stargate-into-glaives", published: true, computedAt: AT,
    userId: "u_leak", baseline: { games: 90, winRate: 0.5, prevalence: 0.2, at: AT }, baselineCandidate: {},
    overall: cell(150, 6, 0.45),
    bands: { league: [cell(120, 6, 0.44, { value: 4, label: "Diamond" }), cell(20, 3, 0.2, { value: 3, label: "Platinum" })], mmr: [] },
    vsStrategy: [cell(40, 5, 0.4, { strategyKey: EIGHT_POOL, strategySlug: "8-pool" }), cell(12, 2, 0.1, { strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool" })],
    timings: {
      samples: 60, users: 6,
      milestones: [
        { key: "Pylon", label: "Pylon", event: "start", games: 60, users: 6, presence: 1, p25: 17, median: 18, p75: 19,
          winners: { games: 30, users: 6, median: 18 }, losers: { games: 30, users: 5, median: 19 } },
        { key: "Stargate", label: "Stargate", event: "start", games: 30, users: 5, presence: 0.5, p25: 170, median: 180, p75: 190 },
      ],
    },
    leaks: { games: 60, users: 6, items: [{ name: "Supply block", games: 40, users: 6, share: 0.6 }, { name: "Idle", games: 5, users: 1, share: 0.1 }] },
  });

  test("a published doc keeps floor-clearing groups only and never its storage fields", () => {
    const out = shapeBuildPayload(buildInput(publishedDoc()));
    expect(out.published).toBe(true);
    expect(out.bands.league.map((b) => b.value)).toEqual([4]);
    expect(out.vsStrategy.map((r) => r.strategySlug)).toEqual(["8-pool"]);
    expect(out.timings.milestones.map((m) => m.key)).toEqual(["Pylon"]);
    expect(out.timings.milestones[0].winners).toEqual({ games: 30, users: 6, median: 18 });
    expect(out.leaks.items.map((i) => i.name)).toEqual(["Supply block"]);
    const text = JSON.stringify(out);
    for (const banned of ["u_leak", "baseline"]) expect(text).not.toContain(banned);
    for (const storage of ["key", "kind", "userId", "baselineCandidate"]) expect(out).not.toHaveProperty(storage);
  });

  test("a winners/losers split is shown only when both sides clear the floor", () => {
    const doc = publishedDoc();
    doc.timings.milestones[0].losers = { games: 10, users: 2, median: 19 };
    const [pylon] = shapeBuildPayload(buildInput(doc)).timings.milestones;
    expect(pylon).not.toHaveProperty("winners");
    expect(pylon).not.toHaveProperty("losers");
  });

  test.each([
    ["overall below the page floor", (d) => { d.overall = cell(99, 6, 0.4); }],
    ["overall users below the page floor", (d) => { d.overall = cell(150, 4, 0.4); }],
    ["no overall cell", (d) => { delete d.overall; }],
    ["an unpublished flag", (d) => { d.published = false; }],
  ])("%s → identity only, not a single number", (_label, mutate) => {
    const doc = publishedDoc();
    mutate(doc);
    const out = shapeBuildPayload(buildInput(doc));
    expect(out.published).toBe(false);
    expect(Object.keys(out).sort()).toEqual([
      "buildKey", "buildSlug", "computedAt", "description", "era", "matchup", "matchupSlug", "name", "patch",
      "published", "videos",
    ]);
    expect(deepNumbers(out)).toEqual([]);
  });
});

describe("shapeCounterPayload / shapeMapPayload", () => {
  const counterInput = (doc) => ({
    matchup: "PvZ", strategyKey: EIGHT_POOL, strategySlug: "8-pool", era: "after", doc, matchupDoc: null, videos: [],
  });

  test("a counter flagged published below the page floor is identity-only", () => {
    const out = shapeCounterPayload(counterInput({
      published: true, computedAt: AT, overall: cell(150, 4, 0.4), openers: [cell(40, 5, 0.4, { buildKey: GLAIVES, buildSlug: "stargate-into-glaives" })],
    }));
    expect(out.published).toBe(false);
    expect(out).not.toHaveProperty("openers");
    expect(deepNumbers(out)).toEqual([]);
  });

  test("a published counter drops below-floor opener rows", () => {
    const out = shapeCounterPayload(counterInput({
      published: true, computedAt: AT, overall: cell(150, 6, 0.4),
      openers: [cell(40, 5, 0.4, { buildKey: GLAIVES, buildSlug: "stargate-into-glaives" }), cell(20, 5, 0.3, { buildKey: ROBO, buildSlug: "robo-opener" })],
    }));
    expect(out.published).toBe(true);
    expect(out.openers.map((o) => o.buildKey)).toEqual([GLAIVES]);
  });

  test("a map flagged published below the page floor is identity-only", () => {
    const out = shapeMapPayload({
      era: "after",
      doc: { published: true, map: "Site Delta LE", mapSlug: "site-delta-le", games: 99, matchups: [cell(99, 6, 0.4, { matchup: "PvZ" })], computedAt: AT },
    });
    expect(out).toEqual({
      published: false, map: "Site Delta LE", mapSlug: "site-delta-le", era: "after", patch: "5.0.16", computedAt: AT,
    });
  });
});

describe("same-named guides of one namespace get distinct page names", () => {
  const MINE = "TvP - Widow Mine Drop";
  const GENERIC = "Terran - Widow Mine Drop";

  test("counter pages, the matchup's counter links and a build's vs-strategy rows", () => {
    const counter = (strategyKey, strategySlug) => shapeCounterPayload({
      matchup: "PvT", strategyKey, strategySlug, era: "after", doc: null, matchupDoc: null, videos: [],
    });
    expect(counter(MINE, "widow-mine-drop").name).toBe("Widow Mine Drop");
    expect(counter(GENERIC, "terran-widow-mine-drop").name).toBe("Widow Mine Drop (any matchup)");
    const matchupInput = { matchup: "PvT", era: "after", band: null, doc: null, buildDocs: [], videos: [] };
    const links = shapeMatchupPayload(matchupInput).counters
      .filter((c) => c.strategyKey === MINE || c.strategyKey === GENERIC)
      .map((c) => c.name);
    expect(links.sort()).toEqual(["Widow Mine Drop", "Widow Mine Drop (any matchup)"]);
    const build = shapeBuildPayload({
      ...buildInput({
        published: true, matchup: "PvT", computedAt: AT, overall: cell(150, 6, 0.4),
        vsStrategy: [
          cell(40, 5, 0.4, { strategyKey: MINE, strategySlug: "widow-mine-drop" }),
          cell(40, 5, 0.3, { strategyKey: GENERIC, strategySlug: "terran-widow-mine-drop" }),
        ],
      }),
      matchup: "PvT", buildKey: "PvT - DT Drop", buildSlug: "dt-drop",
    });
    expect(build.vsStrategy.map((r) => r.name)).toEqual(["Widow Mine Drop", "Widow Mine Drop (any matchup)"]);
  });

  test("build pages and matchup openers", () => {
    const build = shapeBuildPayload({
      ...buildInput(null), matchup: "ZvP", buildKey: "Zerg - 2 Base Nydus", buildSlug: "zerg-2-base-nydus",
    });
    expect(build.name).toBe("2 Base Nydus (any matchup)");
    const out = shapeMatchupPayload({
      matchup: "ZvP", era: "after", band: null, videos: [], buildDocs: [],
      doc: {
        kind: "matchup", matchup: "ZvP", published: true, games: 400, users: 12, computedAt: AT, counters: [],
        builds: [
          { ...cell(60, 6, 0.4), buildKey: "ZvP - 2 Base Nydus", buildSlug: "2-base-nydus", published: true },
          { ...cell(60, 6, 0.3), buildKey: "Zerg - 2 Base Nydus", buildSlug: "zerg-2-base-nydus", published: true },
        ],
      },
    });
    expect(out.openers.map((o) => o.name)).toEqual(["2 Base Nydus", "2 Base Nydus (any matchup)"]);
  });
});

describe("shapeMatchupPayload / shapeIndexPayload", () => {
  // Stored out of order on purpose; the Carrier row is below the CELL floor.
  const matchupDoc = {
    kind: "matchup", matchup: "PvZ", published: true, games: 400, users: 12, computedAt: AT,
    builds: [
      { ...cell(60, 6, 0.30), buildKey: ROBO, buildSlug: "robo-opener", published: false, prevalence: 0.15 },
      { ...cell(29, 9, 0.60), buildKey: CARRIER, buildSlug: "carrier-rush", published: true, prevalence: 0.07 },
      { ...cell(150, 6, 0.45), buildKey: GLAIVES, buildSlug: "stargate-into-glaives", published: true, prevalence: 0.37 },
    ],
    counters: [],
  };

  test("openers are ranked by Wilson lower bound whatever the stored order", () => {
    const out = shapeMatchupPayload({ matchup: "PvZ", era: "after", band: null, doc: matchupDoc, buildDocs: [], videos: [] });
    expect(out.openers.map((o) => o.buildKey)).toEqual([GLAIVES, ROBO]);
  });

  test("band view and options only use floor-clearing band cells", () => {
    const buildDocs = [
      { buildKey: GLAIVES, buildSlug: "stargate-into-glaives", published: true, bands: { league: [cell(40, 5, 0.4, { value: 4, label: "Diamond" })], mmr: [] } },
      { buildKey: ROBO, buildSlug: "robo-opener", published: false, bands: { league: [cell(40, 4, 0.5, { value: 4, label: "Diamond" }), cell(30, 5, 0.2, { value: 5, label: "Master" })], mmr: [] } },
    ];
    const band = { type: "league", value: 4, label: "Diamond" };
    const out = shapeMatchupPayload({ matchup: "PvZ", era: "after", band, doc: matchupDoc, buildDocs, videos: [] });
    expect(out.openers.map((o) => o.buildKey)).toEqual([GLAIVES]);
    expect(out.bandOptions.league).toEqual([{ value: 4, label: "Diamond" }, { value: 5, label: "Master" }]);
  });

  test("the hub lists ≤ 3 published, floor-clearing builds, best first, and page-floor maps", () => {
    const mapDocs = [
      { published: true, map: "Alcyone LE", mapSlug: "alcyone-le", games: 99 },
      { published: true, map: "Site Delta LE", mapSlug: "site-delta-le", games: 150 },
    ];
    const out = shapeIndexPayload({ era: "after", computedAt: AT, matchupDocs: [matchupDoc], mapDocs, videos: [], channel: null });
    const pvz = out.matchups.find((m) => m.matchup === "PvZ");
    expect(pvz.top.map((t) => t.buildKey)).toEqual([GLAIVES]);
    expect(pvz.publishedBuilds).toBe(1);
    expect(out.maps).toEqual([{ map: "Site Delta LE", slug: "site-delta-le", games: 150 }]);
  });
});

describe("shapeSitemapPayload", () => {
  const docs = [
    { kind: "matchup", matchup: "PvZ", published: true },
    { kind: "build", matchup: "PvZ", buildSlug: "stargate-into-glaives", published: true, overall: cell(150, 6, 0.45) },
    { kind: "build", matchup: "PvZ", buildSlug: "robo-opener", published: true, overall: cell(99, 6, 0.3) },
    { kind: "counter", matchup: "PvZ", strategySlug: "8-pool", published: true, overall: cell(120, 4, 0.4) },
    { kind: "map", mapSlug: "site-delta-le", published: true, games: 150 },
    { kind: "map", mapSlug: "alcyone-le", published: true, games: 99 },
    { kind: "run", published: true },
  ];

  test("lists only pages the shapers serve as published", () => {
    const out = shapeSitemapPayload({ computedAt: AT, docs, hasVideos: false });
    expect(out.entries.map((e) => e.path)).toEqual([
      "/guides", "/guides/pvz", "/guides/pvz/stargate-into-glaives", "/guides/maps", "/guides/maps/site-delta-le",
    ]);
    expect(out.entries.every((e) => e.lastModified === AT)).toBe(true);
  });

  test("the hub needs a published build or a video; no run means no entries", () => {
    const noBuild = docs.filter((d) => d.kind !== "build" || d.buildSlug !== "stargate-into-glaives");
    expect(shapeSitemapPayload({ computedAt: AT, docs: noBuild, hasVideos: false }).entries[0].path).toBe("/guides/pvz");
    expect(shapeSitemapPayload({ computedAt: AT, docs: noBuild, hasVideos: true }).entries[0].path).toBe("/guides");
    expect(shapeSitemapPayload({ computedAt: null, docs, hasVideos: true })).toEqual({ computedAt: null, entries: [] });
  });
});
