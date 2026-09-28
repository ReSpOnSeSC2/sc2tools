/**
 * TEST FIXTURES ONLY — counter pages (PvZ vs 8 Pool published, PvZ vs
 * Lurker Contain unpublished), the Old Sun Temple map page, the guide
 * sitemap and the signed-in `/v1/guides/me` comparison.
 */
import {
  FIXTURE_COMPUTED_AT,
  FIXTURE_PATCH,
  fixtureCell,
  fixtureDescription,
} from "@/lib/guides/__fixtures__/cells";
import { VIDEO_PVZ_CRACKING_8_POOLS } from "@/lib/guides/__fixtures__/videos";
import type {
  GuideCell,
  GuideCounterOpener,
  GuideCounterPublished,
  GuideCounterUnpublished,
  GuideMapOpener,
  GuideMapPublished,
  GuideMapUnpublished,
  GuideMePayload,
  GuideSitemapPayload,
} from "@/lib/guides/types";

function displayName(catalogName: string): string {
  return catalogName.slice(catalogName.indexOf(" - ") + " - ".length);
}

function byCiLowDesc<T extends GuideCell>(a: T, b: T): number {
  return b.ci.low - a.ci.low;
}

function counterOpener(buildKey: string, buildSlug: string, cell: GuideCell): GuideCounterOpener {
  return { ...cell, buildKey, buildSlug, name: displayName(buildKey), published: true };
}

function mapOpener(buildKey: string, buildSlug: string, cell: GuideCell): GuideMapOpener {
  return { ...cell, buildKey, buildSlug, name: displayName(buildKey) };
}

export const FIXTURE_COUNTER_PUBLISHED: GuideCounterPublished = {
  published: true,
  matchup: "PvZ",
  matchupSlug: "pvz",
  strategyKey: "Zerg - 8 Pool",
  strategySlug: "8-pool",
  name: "8 Pool",
  description: fixtureDescription("Zerg - 8 Pool"),
  myRace: "Protoss",
  oppRace: "Zerg",
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  videos: [VIDEO_PVZ_CRACKING_8_POOLS],
  overall: fixtureCell(236, 47, 149, 1),
  openers: [
    counterOpener("PvZ - Robo Opener", "robo-opener", fixtureCell(64, 19, 43)),
    counterOpener("PvZ - Stargate into Glaives", "stargate-into-glaives", fixtureCell(52, 16, 33)),
    counterOpener("PvZ - Adept Glaives (Robo)", "adept-glaives-robo", fixtureCell(39, 13, 23)),
  ].sort(byCiLowDesc),
};

export const FIXTURE_COUNTER_UNPUBLISHED: GuideCounterUnpublished = {
  published: false,
  matchup: "PvZ",
  matchupSlug: "pvz",
  strategyKey: "ZvP - Lurker Contain",
  strategySlug: "lurker-contain",
  name: "Lurker Contain",
  description: fixtureDescription("ZvP - Lurker Contain"),
  myRace: "Protoss",
  oppRace: "Zerg",
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  videos: [],
};

export const FIXTURE_MAP: GuideMapPublished = {
  published: true,
  map: "Old Sun Temple",
  mapSlug: "old-sun-temple",
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  games: 2418,
  matchups: [
    {
      matchup: "PvZ",
      slug: "pvz",
      ...fixtureCell(512, 88, 268, 2),
      openers: [
        mapOpener("PvZ - Standard Blink Macro", "standard-blink-macro", fixtureCell(83, 31, 44)),
        mapOpener("PvZ - Stargate into Glaives", "stargate-into-glaives", fixtureCell(61, 23, 36)),
        mapOpener("PvZ - Robo Opener", "robo-opener", fixtureCell(40, 17, 21)),
      ].sort(byCiLowDesc),
    },
    {
      matchup: "ZvP",
      slug: "zvp",
      ...fixtureCell(431, 72, 209, 1),
      openers: [
        mapOpener(
          "Zerg - 17 Hatch 18 Gas 17 Pool",
          "17-hatch-18-gas-17-pool",
          fixtureCell(118, 41, 61),
        ),
      ],
    },
    {
      matchup: "TvZ",
      slug: "tvz",
      ...fixtureCell(377, 61, 199),
      openers: [mapOpener("TvZ - 3 CC Bio", "3-cc-bio", fixtureCell(74, 26, 41))],
    },
    { matchup: "PvP", slug: "pvp", ...fixtureCell(208, 39, 104, 1), openers: [] },
  ],
};

export const FIXTURE_MAP_UNPUBLISHED: GuideMapUnpublished = {
  published: false,
  map: "Washout",
  mapSlug: "washout",
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
};

export const FIXTURE_SITEMAP: GuideSitemapPayload = {
  computedAt: FIXTURE_COMPUTED_AT,
  entries: [
    "/guides",
    "/guides/pvz",
    "/guides/pvz/stargate-into-glaives",
    "/guides/pvz/standard-blink-macro",
    "/guides/pvz/counter/8-pool",
    "/guides/maps/old-sun-temple",
  ].map((path) => ({ path, lastModified: FIXTURE_COMPUTED_AT })),
};

export const FIXTURE_ME: GuideMePayload = {
  matchup: "PvZ",
  buildKey: "PvZ - Stargate into Glaives",
  era: "after",
  games: 37,
  wins: 18,
  losses: 19,
  winRate: 0.4865,
  timings: {
    samples: 31,
    milestones: [
      { key: "Stargate", label: "Stargate", event: "start", median: 176, games: 31 },
      { key: "TwilightCouncil", label: "Twilight Council", event: "start", median: 292, games: 29 },
      {
        key: "AdeptPiercingAttack",
        label: "Resonating Glaives",
        event: "finish",
        median: 447,
        games: 26,
      },
    ],
  },
};
