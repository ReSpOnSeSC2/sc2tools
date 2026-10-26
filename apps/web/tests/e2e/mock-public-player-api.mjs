// Synthetic publication state for public HTTP/privacy tests. This module is
// imported only by the local fixture server; it has no production API route.
import { COMMUNITY_AUTHOR, COMMUNITY_DETAIL } from "./mock-community-detail-api.mjs";
export const PUBLIC_PLAYER_HANDLE = "fixture-builder-0123456789";
const sections = { showReplays: false, showChannels: false, showRecentForm: true, showMmrHistory: true, showSeasons: true, showMaps: true };
const profile = {
  handle: PUBLIC_PLAYER_HANDLE, displayName: COMMUNITY_AUTHOR.displayName, mainRace: "Protoss", joinedAt: COMMUNITY_AUTHOR.joinedAt,
  totals: { games: 30, wins: 20, losses: 10, winRate: 2 / 3 }, matchups: [{ matchup: "vs Z", games: 30, wins: 20, losses: 10, winRate: 2 / 3 }], signatureBuilds: [],
  featuredBuild: { slug: COMMUNITY_AUTHOR.topBuild.slug, title: COMMUNITY_AUTHOR.topBuild.title, matchup: "PvT", votes: 12 }, publishedBuildCount: 6,
  publishedBuilds: COMMUNITY_AUTHOR.builds.map(row => ({ slug: row.slug, title: row.title, matchup: row.matchup, votes: row.votes })),
  reviewer: null, sections, replayArchive: null,
  recentForm: [{ result: "W", matchup: "PvZ", date: "2026-10-23T12:00:00Z" }, { result: "W", matchup: "PvT", date: "2026-10-22T12:00:00Z" }, { result: "L", matchup: "PvP", date: "2026-10-21T12:00:00Z" }], currentStreak: { kind: "W", count: 2 }, lastPlayedAt: "2026-10-23T12:00:00Z",
  mmrHistory: [{ date: "2026-10-12T00:00:00Z", mmr: 4100, games: 10 }, { date: "2026-10-19T00:00:00Z", mmr: 4200, games: 20 }],
  maps: [{ name: "Synthetic Practice LE", games: 30, wins: 20, losses: 10 }], seasons: [], seasonDataAvailable: false,
};
const visibility = new Map();
const PRIVATE_CASE = /^fixture-privacy-[a-f0-9]{10}$/;
export function publicPlayerFixture(path) {
  const build = /^\/v1\/community\/builds\/(fixture-privacy-[a-f0-9]{10})$/.exec(path);
  if (build) return { status: 200, data: { ...COMMUNITY_DETAIL, slug: build[1], authorName: "Privacy Fixture", authorProfileHandle: visibility.get(build[1]) === false ? undefined : build[1] } };
  if (path === "/v1/public/players-sitemap") return { status: 200, data: { items: [{ handle: PUBLIC_PLAYER_HANDLE, lastModified: "2026-10-23T12:00:00Z" }] } };
  if (!path.startsWith("/v1/public/players/")) return null;
  const handle = decodeURIComponent(path.slice("/v1/public/players/".length));
  if (handle === "missing-shared-player") return { status: 404, data: { error: { code: "profile_not_found" } } };
  if (handle === "unavailable-shared-player") return { status: 503, data: { error: { code: "unavailable" } } };
  if ([PUBLIC_PLAYER_HANDLE, "fixture-community-author"].includes(handle)) return { status: 200, data: { profile, handle: profile.handle, displayName: profile.displayName, archiveOnly: false } };
  if (PRIVATE_CASE.test(handle)) {
    if (visibility.get(handle) === false) return { status: 404, data: { error: { code: "profile_not_found" } } };
    const selected = { ...profile, handle, displayName: "Privacy Fixture" };
    return { status: 200, data: { profile: selected, handle, displayName: selected.displayName, archiveOnly: false } };
  }
  return null;
}

/** Only isolated synthetic test namespaces accept this tiny local mutation. */
export async function publicPlayerControl(req, res, path) {
  const match = /^\/__mock\/public-player\/(fixture-privacy-[a-f0-9]{10})\/visibility$/.exec(path);
  if (req.method !== "POST" || !match) return false;
  let body = "";
  try {
    for await (const chunk of req) { body += chunk; if (body.length > 256) throw new Error("too_large"); }
    const data = JSON.parse(body);
    if (typeof data.enabled !== "boolean") throw new Error("invalid");
    if (visibility.size >= 128) visibility.delete(visibility.keys().next().value);
    visibility.set(match[1], data.enabled);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end("{}");
  } catch { res.writeHead(400, { "content-type": "application/json" }).end("{}"); }
  return true;
}
