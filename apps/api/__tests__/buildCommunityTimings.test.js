"use strict";

const { buildSlug, buildNamesForMatchup } = require("../src/config/guideSlugs");
const { milestonesForRace } = require("../src/config/guideMilestones");
const { GUIDE_CURRENT_ERA, GUIDE_PAGE_MIN_GAMES, GUIDE_PAGE_MIN_USERS, GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS } = require("../src/config/guides");
const { comparisonTargets, readCommunityTimings } = require("../src/services/buildCommunityTimings");
const name = "PvZ - 2 Stargate Phoenix";
/** @param {Record<string,any>} [patch] */
const game = (patch = {}) => ({ myRace: "Protoss", opponent: { race: "Zerg" }, gameVersion: "5.0.17.98000", ...patch });
/** @param {Record<string,any>} [patch] */
const milestone = (patch = {}) => ({ key: "Gateway", label: "Gateway", event: "start", games: GUIDE_CELL_MIN_GAMES + 100,
  users: GUIDE_CELL_MIN_USERS + 10, presence: 1, p25: 100, median: 120, p75: 140, ...patch });
/** @param {string} [build] @param {string} [matchup] */
function doc(build = name, matchup = "PvZ") {
  const slug = buildSlug(matchup, build);
  return { key: `build:${GUIDE_CURRENT_ERA}:${matchup}:${slug}`, buildKey: build, buildSlug: slug, matchup, era: GUIDE_CURRENT_ERA,
    published: true, computedAt: new Date("2026-10-01"),
    overall: { games: GUIDE_PAGE_MIN_GAMES + 100, users: GUIDE_PAGE_MIN_USERS + 10, wins: 100, winRate: 0.5, ci: { low: 0.4, high: 0.6 } },
    timings: { samples: GUIDE_CELL_MIN_GAMES + 100, users: GUIDE_CELL_MIN_USERS + 10, milestones: [milestone()] },
    secretAdminField: "never forward", userId: "never forward" };
}
/** @param {Record<string,any>[]} docs */
function collection(docs) {
  const limit = jest.fn(() => ({ toArray: async () => docs }));
  const find = jest.fn(/** @param {Record<string,any>} _query @param {Record<string,any>} _opts */ (_query, _opts) => ({ limit }));
  return { find, limit };
}

test("one bounded indexed batch returns only same-era published comparable construction starts", async () => {
  const rows = collection([doc()]);
  const result = await readCommunityTimings(/** @type {any} */ (rows), name, [game()]);
  expect(result.PvZ).toMatchObject({ href: "/guides/pvz/2-stargate-phoenix", era: GUIDE_CURRENT_ERA,
    rows: [{ token: "Gateway", p25Seconds: 100, medianSeconds: 120, p75Seconds: 140, event: "start" }] });
  expect(rows.find).toHaveBeenCalledTimes(1); expect(rows.limit).toHaveBeenCalledWith(1);
  expect(rows.find.mock.calls[0][0]).toMatchObject({ kind: "build", era: GUIDE_CURRENT_ERA, published: true });
  expect(JSON.stringify(result)).not.toContain("never forward");
});

test.each([
  { games: [game({ _customBuildSlug: "private-copy" })] },
  { games: [game(), game({ gameVersion: "5.0.16.97425" })] },
  { games: [game({ gameVersion: undefined, date: undefined })] },
])("custom provenance or mixed/unknown eras never produce a misleading catalog delta", async ({ games }) => {
  const rows = collection([doc()]);
  expect(await readCommunityTimings(/** @type {any} */ (rows), name, games)).toEqual({});
  expect(rows.find).not.toHaveBeenCalled();
});

test("a fuzzy private name is never treated as a published catalog identity", () => {
  expect(comparisonTargets("My 2 Stargate Phoenix variation", [game()])).toEqual([]);
});

test("completion morphs and later occurrences cannot be compared with DNA first-start timings", async () => {
  const build = buildNamesForMatchup("ZvP")[0], value = doc(build, "ZvP");
  const differentEvents = milestonesForRace("ZvP").filter(row => row.event === "finish" || row.occurrence !== 1);
  expect(differentEvents.length).toBeGreaterThan(0);
  value.timings.milestones = differentEvents.map(row => milestone({ key: row.key, label: row.label, event: row.event }));
  expect(await readCommunityTimings(/** @type {any} */ (collection([value])), build,
    [game({ myRace: "Zerg", opponent: { race: "Protoss" } })])).toEqual({});
});

test("serve-time publication, sample and milestone floors remain authoritative", async () => {
  const lowPage = doc(); lowPage.overall.games = 1;
  const lowSamples = doc(); lowSamples.timings.samples = 1;
  const lowMilestone = doc(); lowMilestone.timings.milestones[0].games = 1;
  const inverted = doc(); inverted.timings.milestones[0].p25 = 200;
  const unpublished = doc(); unpublished.published = false;
  for (const value of [lowPage, lowSamples, lowMilestone, inverted, unpublished]) {
    expect(await readCommunityTimings(/** @type {any} */ (collection([value])), name, [game()])).toEqual({});
  }
});

test("an unavailable optional public snapshot leaves private timings usable", async () => {
  expect(await readCommunityTimings(undefined, name, [game()])).toEqual({});
  const failed = { find: () => { throw new Error("synthetic snapshot unavailable"); } };
  expect(await readCommunityTimings(/** @type {any} */ (failed), name, [game()])).toEqual({});
});
