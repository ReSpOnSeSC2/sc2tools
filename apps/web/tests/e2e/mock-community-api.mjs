// Synthetic list data is opt-in through the test search prefix. The ordinary
// /community smoke still sees an absent API, preserving its outage contract.
const RACES = ["Protoss", "Terran", "Zerg"];
const OPPONENTS = ["Terran", "Zerg", "Any"];
const BUILDS = Array.from({ length: 360 }, (_, index) => {
  const race = RACES[index % 3]; const vsRace = OPPONENTS[Math.floor(index / 3) % 3];
  return {
    slug: `fixture-community-${index}`, title: `Fixture macro opener ${index + 1}`, description: "Fixture build for practicing a safe opening and steady worker production.",
    matchup: `${race[0]}v${vsRace === "Any" ? "Any" : vsRace[0]}`, authorName: "Fixture author", ownerUserId: "fixture-owner",
    votes: index % 7 - 2, publishedAt: new Date(Date.UTC(2026, 8, index % 28 + 1)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, index % 22 + 1)).toISOString(),
    build: { race, vsRace, skillLevel: index % 2 ? "gold" : "diamond", rules: [] },
  };
});

export function communityFixture(url) {
  if (url.pathname !== "/v1/community/builds" || !/^fixture(?:\s|$)/i.test(url.searchParams.get("q") || "")) return null;
  const query = url.searchParams; const race = RACES.find((name) => name[0] === query.get("race")); const vs = RACES.find((name) => name[0] === query.get("vsRace"));
  const search = query.get("q").toLowerCase();
  const items = BUILDS.filter((build) => (!race || build.build.race === race) && (!vs || [vs, "Any"].includes(build.build.vsRace)) && (!query.get("skill") || build.build.skillLevel === query.get("skill")) && `${build.title} ${build.description} ${build.authorName}`.toLowerCase().includes(search));
  const sort = query.get("sort");
  items.sort((a, b) => sort === "updated" ? b.updatedAt.localeCompare(a.updatedAt) || b.publishedAt.localeCompare(a.publishedAt) : sort === "new" ? b.publishedAt.localeCompare(a.publishedAt) : b.votes - a.votes);
  const offset = Math.max(0, Number(query.get("offset")) || 0); const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 24));
  return { items: items.slice(offset, offset + limit), total: items.length, hasMore: offset + limit < items.length, offset, limit };
}
