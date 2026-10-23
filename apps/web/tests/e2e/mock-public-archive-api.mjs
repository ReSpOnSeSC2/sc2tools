// Synthetic public archive only. No authentication bypass or production writes.
export const ARCHIVE_HANDLE = "fixture-archive-player";
const profile = { handle: ARCHIVE_HANDLE, displayName: "Fixture Player" };
const items = Array.from({ length: 65 }, (_, index) => ({
  gameId: `archive-${index + 1}`, date: new Date(Date.UTC(2026, 9, 22 - index, 20, 42)).toISOString(),
  result: index % 5 === 0 ? "Tie" : index % 2 ? "Victory" : "Defeat", map: index % 3 ? "Alcyone LE" : "Oceanborn LE",
  matchup: index % 3 ? "PvZ" : "PvT", myRace: "Protoss", myBuild: index % 2 ? "Blink pressure" : "Oracle opening", myMmr: 4321,
  durationSec: 600 + index * 10, macroScore: 79, opponent: { displayName: `Fixture rival ${index + 1}`, race: index % 3 ? "Zerg" : "Terran", mmr: 4400, strategy: "Safe opening" },
  replayAvailable: true, replaySizeBytes: 123456,
  streams: index === 0 ? [{ platform: "twitch", perspective: "me", playerName: "Fixture Player", url: "https://www.twitch.tv/videos/123456", offsetSec: 42 }] : [],
}));

export function publicArchiveFixture(rawUrl) {
  const url = new URL(rawUrl, "http://fixture.local");
  if (url.pathname !== `/v1/public/replays/${ARCHIVE_HANDLE}`) return null;
  if (url.searchParams.get("fields") === "profile") return { profile, items: [], page: { hasMore: false } };
  const q = url.searchParams;
  const filtered = items.filter((item) => (!q.get("result") || item.result === ({ win: "Victory", loss: "Defeat", tie: "Tie" })[q.get("result")])
    && (!q.get("matchup") || item.matchup === q.get("matchup")) && (!q.get("map") || item.map.toLowerCase().includes(q.get("map").toLowerCase()))
    && (!q.get("build") || item.myBuild === q.get("build")) && (!q.get("search") || [item.map, item.opponent.displayName, item.myBuild, item.opponent.strategy].some((label) => label.toLowerCase().includes(q.get("search").toLowerCase())))
    && (!q.get("since") || item.date >= q.get("since")) && (!q.get("until") || item.date <= q.get("until")));
  if (q.get("sort") === "date_asc") filtered.reverse();
  const offset = Math.max(0, Number((q.get("cursor") || "").replace("offset:", "")) || 0); const limit = Math.min(100, Number(q.get("limit")) || 25);
  const pageItems = filtered.slice(offset, offset + limit); const hasMore = offset + limit < filtered.length;
  const count = (result) => filtered.filter((item) => item.result === result).length;
  return { profile, items: pageItems, page: { hasMore, nextCursor: hasMore ? `offset:${offset + limit}` : null }, total: filtered.length,
    summary: { total: filtered.length, wins: count("Victory"), losses: count("Defeat"), ties: count("Tie"), avgDurationSec: filtered.length ? filtered.reduce((sum, item) => sum + item.durationSec, 0) / filtered.length : null },
    facets: { matchups: ["PvT", "PvZ"], maps: ["Alcyone LE", "Oceanborn LE"] },
  };
}
