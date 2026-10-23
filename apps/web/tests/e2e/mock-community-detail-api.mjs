// Only these synthetic public identifiers opt in; ordinary Community outages remain unchanged.
export const COMMUNITY_DETAIL = {
  slug: "fixture-community-polish", title: "Fixture safe opening", matchup: "PvZ", votes: 3,
  authorName: "FixtureBuilder", ownerUserId: "fixture-community-author", publishedAt: "2026-03-01T00:30:00Z", updatedAt: "2026-10-03T23:30:00Z",
  description: "Scout early and keep worker production steady while preparing a safe expansion. ".repeat(5).trim() + "\n\nUse the second paragraph to plan the transition after defending pressure.",
  build: { race: "Protoss", vsRace: "Zerg", perspective: "you", skillLevel: "diamond", rules: [
    { type: "before", name: "BuildGateway", time_lt: 60 }, { type: "before", name: "BuildCyberneticsCore", time_lt: 120 },
    { type: "count_min", name: "TrainAdept", count: 2, time_lt: 180 }, { type: "before", name: "BuildStargate", time_lt: 240 },
    { type: "count_max", name: "BuildRoboticsFacility", count: 0, time_lt: 300 },
  ] },
};
const builds = Array.from({ length: 6 }, (_, i) => ({ ...COMMUNITY_DETAIL, slug: i ? `fixture-community-${i}` : COMMUNITY_DETAIL.slug, title: i ? `Fixture opener ${i}` : COMMUNITY_DETAIL.title, description: i === 2 ? "A scouting timing to practice" : "Macro opening with steady workers", matchup: i < 4 ? "PvZ" : "PvT", authorName: "A".repeat(80), votes: i === 4 ? 12 : 0, publishedAt: `2026-0${8 - i}-01T00:00:00Z` }));
export const COMMUNITY_AUTHOR = { userId: "fixture-community-author", displayName: "FixtureBuilder", joinedAt: "2025-01-01T00:00:00Z", builds, totalBuilds: 6, totalVotes: 12, primaryRace: "Protoss", topMatchup: "PvZ", topBuild: builds[4], recent: [] };
export const COMMUNITY_DETAIL_ROUTES = new Map([
  [`/v1/community/builds/${COMMUNITY_DETAIL.slug}`, COMMUNITY_DETAIL],
  ["/v1/community/authors/fixture-community-author", COMMUNITY_AUTHOR],
]);
