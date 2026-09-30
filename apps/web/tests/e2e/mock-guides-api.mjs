// Guide fixture routes for the Playwright responsive smoke, served by
// tests/e2e/mock-review-api.mjs (which drops every other connection).
//
// ALL NUMBERS HERE ARE SYNTHETIC TEST FIXTURE DATA — made-up counts on a
// fake map ("Fixture Station LE"), never shown outside the e2e harness.
// Only the catalog names and slugs are real (from
// apps/api/src/config/guideSlugs.lock.json), because the web resolves
// slugs against the catalog. Shapes mirror apps/web/lib/guides/types.ts
// (the __fixtures__ there are TypeScript; this is plain JS for Node).
// Cells are internally consistent: winRate = wins / decided games and ci
// is the 95% Wilson interval, rounded to 4 dp like the API.

const NOW = "2026-09-27T03:12:44.000Z";
const BASELINE = "2026-09-19T03:10:02.000Z";
const PATCH = "5.0.16";
const MAP = "Fixture Station LE";
const MAP_SLUG = "fixture-station-le";
const WILSON_Z = 1.96;
const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];

const round4 = (value) => Math.round(value * 10_000) / 10_000;

/** Contract cell from raw counts (ties count toward games only). */
function cell(games, users, wins, ties = 0) {
  const n = games - ties;
  const p = wins / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { games, users, wins, winRate: round4(p), ci: { low: round4(center - margin), high: round4(center + margin) } };
}

const opener = (buildKey, buildSlug, counts, published = true) => ({
  ...cell(...counts),
  buildKey,
  buildSlug,
  name: buildKey.slice(buildKey.indexOf(" - ") + 3),
  published,
  prevalence: round4(counts[0] / 2400),
  trend: published ? { winRateDelta: 0.012, prevalenceDelta: 0.004, since: BASELINE } : null,
  isNew: false,
});

// Synthetic PvZ ranking, ci.low desc like the API.
const PVZ_OPENERS = [
  opener("PvZ - Stargate into Glaives", "stargate-into-glaives", [420, 64, 238]),
  opener("PvZ - Standard Blink Macro", "standard-blink-macro", [380, 58, 199]),
  opener("PvZ - Robo Opener", "robo-opener", [260, 41, 131]),
  opener("PvZ - Carrier Rush", "carrier-rush", [40, 9, 18], false),
].sort((a, b) => b.ci.low - a.ci.low);

const PVZ_GAMES = 2400;
const PVZ_USERS = 310;

const unpublishedMatchup = (matchup) => ({
  matchup, slug: matchup.toLowerCase(), published: false, games: null, users: null, top: [], publishedBuilds: 0,
});

const INDEX = {
  computedAt: NOW,
  era: "after",
  patch: PATCH,
  matchups: MATCHUPS.map((matchup) =>
    matchup !== "PvZ"
      ? unpublishedMatchup(matchup)
      : {
        matchup, slug: "pvz", published: true, games: PVZ_GAMES, users: PVZ_USERS,
        top: PVZ_OPENERS.filter((row) => row.published).slice(0, 3).map((row) => ({
          buildKey: row.buildKey, buildSlug: row.buildSlug, name: row.name, games: row.games, users: row.users,
          winRate: row.winRate, ci: row.ci, trend: row.trend, isNew: row.isNew,
        })),
        publishedBuilds: PVZ_OPENERS.filter((row) => row.published).length,
      },
  ),
  maps: [{ map: MAP, slug: MAP_SLUG, games: 640 }],
  videos: [],
  channel: null,
};

const MATCHUP = {
  matchup: "PvZ",
  slug: "pvz",
  era: "after",
  patch: PATCH,
  computedAt: NOW,
  published: true,
  games: PVZ_GAMES,
  users: PVZ_USERS,
  band: null,
  bandOptions: { league: [{ value: 4, label: "Diamond" }], mmr: [] },
  openers: PVZ_OPENERS,
  counters: [
    { strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool", name: "12 Pool", published: true, games: 180 },
    { strategyKey: "ZvP - 2 Base Nydus", strategySlug: "2-base-nydus", name: "2 Base Nydus", published: false, games: null },
  ],
  videos: [],
};

const SG = PVZ_OPENERS.find((row) => row.buildSlug === "stargate-into-glaives");
const DIAMOND = cell(150, 26, 88);

const milestone = (key, label, event, games, quantiles) => ({
  key, label, event, games, users: 52, presence: round4(games / 380), p25: quantiles[0], median: quantiles[1], p75: quantiles[2],
});

const BUILD = {
  published: true,
  matchup: "PvZ",
  matchupSlug: "pvz",
  buildKey: SG.buildKey,
  buildSlug: SG.buildSlug,
  name: SG.name,
  description: "Synthetic e2e fixture description of the opener.",
  era: "after",
  patch: PATCH,
  computedAt: NOW,
  videos: [],
  overall: cell(SG.games, SG.users, SG.wins),
  prevalence: SG.prevalence,
  matchupGames: PVZ_GAMES,
  headline: { scope: "league", value: 4, label: "Diamond", games: DIAMOND.games, winRate: DIAMOND.winRate },
  bands: {
    league: [
      { value: 3, label: "Platinum", ...cell(96, 18, 50) },
      { value: 4, label: "Diamond", ...DIAMOND },
      { value: 5, label: "Master", ...cell(88, 15, 47) },
    ],
    mmr: [],
  },
  timings: {
    samples: 380,
    users: 60,
    milestones: [
      milestone("Gateway", "Gateway", "start", 372, [66, 69, 73]),
      milestone("CyberneticsCore", "Cybernetics Core", "start", 368, [98, 102, 107]),
      milestone("Stargate", "Stargate", "start", 351, [201, 212, 224]),
    ],
  },
  army: {
    360: {
      samples: 340,
      users: 55,
      units: [
        { unit: "Adept", presence: 0.93, median: 6, games: 316 },
        { unit: "Oracle", presence: 0.71, median: 1, games: 241 },
      ],
    },
  },
  vsStrategy: [
    { ...cell(120, 30, 70), strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool", name: "12 Pool", published: true },
  ],
  lengths: [
    { ...cell(140, 40, 81), bucket: "6-10", minSec: 360, maxSec: 600 },
    { ...cell(160, 44, 88), bucket: "10-15", minSec: 600, maxSec: 900 },
  ],
  maps: [{ ...cell(150, 36, 85), map: MAP, mapSlug: MAP_SLUG }],
  macro: { avgScore: 71, games: 300, users: 50 },
  leaks: null,
  trend: SG.trend,
  isNew: false,
  firstPublishedAt: "2026-08-02T03:11:37.000Z",
  related: PVZ_OPENERS.filter((row) => row.buildSlug !== SG.buildSlug).map((row) => ({
    buildKey: row.buildKey, buildSlug: row.buildSlug, name: row.name, published: row.published,
    games: row.games, winRate: row.winRate, ci: row.ci,
  })),
  communityBuilds: [],
  examples: [],
  notes: null,
};

const SITEMAP = {
  computedAt: NOW,
  entries: ["/guides", "/guides/pvz", "/guides/pvz/stargate-into-glaives", "/guides/pvz/counter/12-pool"].map((path) => ({
    path, lastModified: NOW,
  })),
};

/** Exact API paths → JSON bodies (200). */
export const GUIDE_ROUTES = new Map([
  ["/v1/guides", INDEX],
  ["/v1/guides/pvz", MATCHUP],
  ["/v1/guides/pvz/stargate-into-glaives", BUILD],
  ["/v1/guides/sitemap", SITEMAP],
]);

/** The headline stat the e2e spec expects on the build page ("58.7%"). */
export const E2E_BUILD_HEADLINE = `${(DIAMOND.winRate * 100).toFixed(1)}%`;
