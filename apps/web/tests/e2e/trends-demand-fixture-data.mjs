/** Synthetic DTOs for the actual Trends hooks. No production data or transport. */
export const TRENDS_FIXTURE_FILTERS = Object.freeze({
  race: "P", opp_race: "Z", map_pool: "ladder", game_size: "1v1",
  since: "2026-10-01", until: "2026-10-26", regions: "NA", accounts: "1-S2-1-101",
});

const days = Array.from({ length: 16 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
const record = (wins = 12, losses = 8) => ({ wins, losses, total: wins + losses, winRate: wins / (wins + losses) });
const rating = (owner) => ({
  matchup: "PvZ", totalGames: 65, sampleGames: 16, windowGames: 10, ratedGames: 14,
  excludedNoMmr: 2, perfRating: owner === "owner-b" ? 4321 : 4120,
  points: days.map((day, index) => ({ date: `${day}T12:00:00Z`, games: Math.min(index + 1, 10), ratedGames: Math.max(1, Math.min(index + 1, 10) - 1), excludedNoMmr: index ? 1 : 0, perfRating: index === 2 || index === 15 ? null : 4000 + index * 14 })),
});
const mmrPoints = days.map((bucket, index) => ({ bucket, openMmr: 3990 + index * 10, closeMmr: 4000 + index * 10, avgMmr: 4000 + index * 10, minMmr: 3980 + index * 10, maxMmr: 4020 + index * 10, ...record() }));
const peak = { bucket: days.at(-1), mmr: 4150 };
const trough = { bucket: days[0], mmr: 4000 };
const dailySwings = { timezone: "UTC", bestGain: { day: days[2], netMmr: 40, measuredGames: 20, wins: 12, losses: 8 }, biggestLoss: { day: days[3], netMmr: -20, measuredGames: 20, wins: 8, losses: 12 }, measuredDays: 2, measuredGames: 40 };
const EXPLORER_ENDPOINTS = new Set(["mmr-gap", "periods", "groups", "execution", "leads", "breaks", "rematches"].map(view => `/v1/trends/explorer/${view}`));

/** @param {string} pathname @param {string} [search] @param {string} [owner] */
export function trendsFixturePayload(pathname, search = "", owner = "owner-a") {
  const route = pathname.replace("/v1/admin/global-trends/", "/v1/");
  const query = new URLSearchParams(search);
  const interval = query.get("interval") || "week";
  if (route === "/v1/timeseries") return { interval, points: days.map((bucket) => ({ bucket, ...record(owner === "owner-b" ? 15 : 12, 8) })) };
  if (route === "/v1/timeseries/matchups") return { interval: "day", points: days.map((bucket) => ({ bucket, matchup: "PvZ", ...record() })), ratingSeries: [rating(owner)] };
  if (route === "/v1/timeseries/mmr") return { interval, points: mmrPoints, peak, trough, latest: peak, series: [{ seriesKey: "1-S2-1-101|P", toonHandle: "1-S2-1-101", region: "NA", ladderRace: "P", label: "Synthetic NA Protoss", points: mmrPoints, peak, trough, latest: peak }] };
  if (route === "/v1/mmr-by-matchup") return {
    matchups: [{ matchup: "PvZ", myRace: "P", opponentRace: "Z", netMmr: 40, avgDelta: 2, pairs: 20, games: 20, ...record() }],
    coverage: [{ matchup: "PvZ", totalGames: 24, eligibleGames: 24, measuredGames: 20, dropped: { terminalGame: 4 } }], totalGames: 24, eligibleGames: 24, dailySwings,
  };
  if (route === "/v1/opp-mmr-buckets") return { bucketWidth: 500, buckets: [{ lo: 4000, hi: 4500, label: "4000–4499", avgMmr: 4200, minMmr: 4000, maxMmr: 4499, ...record() }], unknown: { ...record(2, 1) } };
  if (route === "/v1/momentum") return { sessionGapMinutes: 90, baseline: record(24, 16), postWin: record(14, 6), postLoss: record(10, 10), sessionPositions: [1, 2, 3].map((pos) => ({ pos, ...record(6, 4) })) };
  if (route === "/v1/length-buckets") return {
    buckets: [{ bucket: "9–12m", avgSec: 630, ...record() }],
    summary: { games: 20, totalSec: 12600, avgSec: 630, medianSec: 625, longGameRate: .1 },
    matchups: [{ matchup: "PvZ", myRace: "P", opponentRace: "Z", games: 20, wins: 12, losses: 8, totalSec: 12600, avgSec: 630, medianSec: 625, avgWinSec: 650, avgLossSec: 600, longGameRate: .1 }],
  };
  if (route === "/v1/timeseries/day-hour") return { timezone: "UTC", cells: [{ dow: 1, hour: 12, ...record() }, { dow: 5, hour: 20, ...record(4, 6) }], totalGames: 30 };
  if (route === "/v1/activity-calendar") return { timezone: "UTC", days: days.map((day) => ({ day, ...record(3, 2) })) };
  if (route === "/v1/timeseries/maps") return { interval: "day", points: days.map((bucket) => ({ bucket, key: "Alcyone LE", ...record(3, 2) })) };
  if (route === "/v1/me/fingerprint") return { fingerprint: null };
  if (EXPLORER_ENDPOINTS.has(route)) return {
    view: route.split("/").at(-1), totalGames: 40, eligibleGames: 30, preparation: { pendingGames: 0 },
    notes: ["Synthetic local replay facts for request and interaction proof."],
    rows: [{ key: "near", label: "Near the player's MMR", games: 30, wins: 18, losses: 12, decided: 30, winRate: .6, players: 1, avgMmr: 4100, avgDurationSec: 630 }],
    options: { players: [{ id: "1-S2-1-101", label: "Synthetic NA Protoss", currentMmr: 4100 }], builds: ["Synthetic opening"], milestones: [{ id: "third-base", label: "Third base" }] },
  };
  return null;
}

/** Retain every transmission; grouping does not pretend shared hooks are calls. */
export function trendsGetSummary(reads) {
  const byPath = {}, byResource = {};
  for (const row of reads) {
    byPath[row.path] = (byPath[row.path] || 0) + 1;
    const resource = row.path + row.search;
    byResource[resource] = (byResource[resource] || 0) + 1;
  }
  return { total: reads.length, byPath, byResource };
}
