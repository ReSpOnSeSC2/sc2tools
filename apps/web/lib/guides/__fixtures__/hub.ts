/**
 * TEST FIXTURES ONLY — `GET /v1/guides` (hub) payload: all nine
 * matchups (three still unpublished), top builds, maps, channel videos.
 */
import {
  FIXTURE_BASELINE_AT,
  FIXTURE_COMPUTED_AT,
  FIXTURE_PATCH,
  fixtureCell,
} from "@/lib/guides/__fixtures__/cells";
import { FIXTURE_MATCHUP } from "@/lib/guides/__fixtures__/matchup";
import {
  FIXTURE_CHANNEL,
  VIDEO_PVT_STARGATE_CHARGE,
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_CRACKING_8_POOLS,
  VIDEO_PVZ_STARGATE_GLAIVES,
} from "@/lib/guides/__fixtures__/videos";
import type {
  GuideIndexMatchup,
  GuideIndexPayload,
  GuideIndexTopBuild,
  GuideMatchup,
} from "@/lib/guides/types";

const TOP_PER_MATCHUP = 3;

function topRow(
  buildKey: string,
  buildSlug: string,
  counts: [games: number, users: number, wins: number],
  isNew = false,
): GuideIndexTopBuild {
  const cell = fixtureCell(...counts);
  return {
    buildKey,
    buildSlug,
    name: buildKey.slice(buildKey.indexOf(" - ") + " - ".length),
    games: cell.games,
    users: cell.users,
    winRate: cell.winRate,
    ci: cell.ci,
    trend: isNew ? null : { winRateDelta: 0.0068, prevalenceDelta: 0.0009, since: FIXTURE_BASELINE_AT },
    isNew,
  };
}

function unpublished(matchup: GuideMatchup): GuideIndexMatchup {
  return {
    matchup,
    slug: matchup.toLowerCase(),
    published: false,
    games: null,
    users: null,
    top: [],
    publishedBuilds: 0,
  };
}

const PVZ_TOP: GuideIndexTopBuild[] = FIXTURE_MATCHUP.openers
  .filter((row) => row.published)
  .slice(0, TOP_PER_MATCHUP)
  .map((row) => ({
    buildKey: row.buildKey,
    buildSlug: row.buildSlug,
    name: row.name,
    games: row.games,
    users: row.users,
    winRate: row.winRate,
    ci: row.ci,
    trend: row.trend,
    isNew: row.isNew,
  }));

export const FIXTURE_INDEX: GuideIndexPayload = {
  computedAt: FIXTURE_COMPUTED_AT,
  era: "after",
  patch: FIXTURE_PATCH,
  matchups: [
    unpublished("PvP"),
    {
      matchup: "PvT",
      slug: "pvt",
      published: true,
      games: 5210,
      users: 402,
      top: [
        topRow("PvT - Standard Charge Macro", "standard-charge-macro", [702, 96, 371]),
        topRow("PvT - Stargate into Charge", "stargate-into-charge", [318, 54, 169], true),
      ],
      publishedBuilds: 2,
    },
    {
      matchup: "PvZ",
      slug: "pvz",
      published: true,
      games: FIXTURE_MATCHUP.games,
      users: FIXTURE_MATCHUP.users,
      top: PVZ_TOP,
      publishedBuilds: 4,
    },
    unpublished("TvP"),
    unpublished("TvT"),
    {
      matchup: "TvZ",
      slug: "tvz",
      published: true,
      games: 3988,
      users: 297,
      top: [topRow("TvZ - 3 CC Bio", "3-cc-bio", [455, 67, 243])],
      publishedBuilds: 1,
    },
    {
      matchup: "ZvP",
      slug: "zvp",
      published: true,
      games: 6102,
      users: 468,
      top: [
        topRow("Zerg - 17 Hatch 18 Gas 17 Pool", "17-hatch-18-gas-17-pool", [1480, 171, 771]),
        topRow("ZvP - Hatch First Macro", "hatch-first-macro", [980, 122, 498]),
      ],
      publishedBuilds: 2,
    },
    unpublished("ZvT"),
    unpublished("ZvZ"),
  ],
  maps: [
    { map: "Old Sun Temple", slug: "old-sun-temple", games: 2418 },
    { map: "Rainfall", slug: "rainfall", games: 2107 },
    { map: "Lockdown", slug: "lockdown", games: 1876 },
  ],
  videos: [
    VIDEO_PVZ_CARRIER_RUSH,
    VIDEO_PVT_STARGATE_CHARGE,
    VIDEO_PVZ_STARGATE_GLAIVES,
    VIDEO_PVZ_CRACKING_8_POOLS,
  ],
  channel: FIXTURE_CHANNEL,
};
