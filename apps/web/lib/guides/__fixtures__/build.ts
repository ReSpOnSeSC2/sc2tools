/**
 * TEST FIXTURES ONLY — `GET /v1/guides/:matchup/:build` payloads.
 * PvZ Stargate into Glaives (published, every section populated) and
 * PvZ Carrier Rush (below the page floor: no numbers, but the owner's
 * real video still ships).
 */
import {
  FIXTURE_BASELINE_AT,
  FIXTURE_COMPUTED_AT,
  FIXTURE_FIRST_PUBLISHED_AT,
  FIXTURE_PATCH,
  fixtureCell,
  fixtureDescription,
  fixtureShare,
} from "@/lib/guides/__fixtures__/cells";
import {
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_STARGATE_GLAIVES,
} from "@/lib/guides/__fixtures__/videos";
import type {
  GuideArmyCheckpoint,
  GuideBuildPublished,
  GuideBuildUnpublished,
  GuideMilestone,
  GuideMilestoneEvent,
  GuideMilestoneSplit,
} from "@/lib/guides/types";

const TIMING_SAMPLES = 356;
const MATCHUP_GAMES = 6840;
const STARGATE_GLAIVES = "PvZ - Stargate into Glaives";

interface MilestoneSeed {
  key: string;
  label: string;
  event: GuideMilestoneEvent;
  games: number;
  users: number;
  quantiles: [number, number, number];
  winners?: GuideMilestoneSplit;
  losers?: GuideMilestoneSplit;
}

function milestone(seed: MilestoneSeed): GuideMilestone {
  const [p25, median, p75] = seed.quantiles;
  const row: GuideMilestone = {
    key: seed.key,
    label: seed.label,
    event: seed.event,
    games: seed.games,
    users: seed.users,
    presence: fixtureShare(seed.games, TIMING_SAMPLES),
    p25,
    median,
    p75,
  };
  if (seed.winners && seed.losers) {
    row.winners = seed.winners;
    row.losers = seed.losers;
  }
  return row;
}

/**
 * Protoss milestones in payload order — keys, labels and events exactly as
 * apps/api/src/config/guideMilestones.js (the API lists them in catalog order).
 */
export const FIXTURE_PVZ_MILESTONES: GuideMilestone[] = [
  milestone({ key: "Pylon", label: "Pylon", event: "start", games: 356, users: 58, quantiles: [17, 18, 20] }),
  milestone({ key: "Gateway", label: "Gateway", event: "start", games: 355, users: 58, quantiles: [38, 40, 44] }),
  milestone({ key: "Assimilator", label: "Assimilator", event: "start", games: 354, users: 58, quantiles: [48, 51, 57] }),
  milestone({ key: "Nexus#2", label: "2nd Nexus", event: "start", games: 352, users: 58, quantiles: [80, 84, 90] }),
  milestone({ key: "CyberneticsCore", label: "Cybernetics Core", event: "start", games: 353, users: 58, quantiles: [93, 97, 103] }),
  milestone({ key: "WarpGateResearch", label: "Warpgate", event: "finish", games: 338, users: 57, quantiles: [238, 246, 259] }),
  milestone({
    key: "TwilightCouncil",
    label: "Twilight Council",
    event: "start",
    games: 331,
    users: 56,
    quantiles: [278, 290, 305],
    winners: { games: 170, users: 43, median: 284 },
    losers: { games: 159, users: 40, median: 297 },
  }),
  milestone({
    key: "Stargate",
    label: "Stargate",
    event: "start",
    games: 349,
    users: 58,
    quantiles: [165, 172, 181],
    winners: { games: 181, users: 44, median: 170 },
    losers: { games: 166, users: 41, median: 175 },
  }),
  milestone({
    key: "AdeptPiercingAttack",
    label: "Resonating Glaives",
    event: "finish",
    games: 318,
    users: 55,
    quantiles: [430, 441, 458],
    winners: { games: 165, users: 42, median: 436 },
    losers: { games: 151, users: 39, median: 449 },
  }),
  milestone({ key: "Nexus#3", label: "3rd Nexus", event: "start", games: 301, users: 52, quantiles: [262, 281, 309] }),
];

function checkpoint(
  samples: number,
  users: number,
  units: Array<[unit: string, games: number, median: number]>,
): GuideArmyCheckpoint {
  return {
    samples,
    users,
    units: units.map(([unit, games, median]) => ({
      unit,
      presence: fixtureShare(games, samples),
      median,
      games,
    })),
  };
}

const PVZ_SG_GLAIVES_OVERALL = fixtureCell(412, 63, 221, 2);
const DIAMOND_CELL = fixtureCell(146, 24, 82, 1);

export const FIXTURE_BUILD_PUBLISHED: GuideBuildPublished = {
  published: true,
  matchup: "PvZ",
  matchupSlug: "pvz",
  buildKey: STARGATE_GLAIVES,
  buildSlug: "stargate-into-glaives",
  name: "Stargate into Glaives",
  description: fixtureDescription(STARGATE_GLAIVES),
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  videos: [VIDEO_PVZ_STARGATE_GLAIVES],
  overall: PVZ_SG_GLAIVES_OVERALL,
  prevalence: fixtureShare(412, MATCHUP_GAMES),
  matchupGames: MATCHUP_GAMES,
  headline: {
    scope: "league",
    value: 4,
    label: "Diamond",
    games: DIAMOND_CELL.games,
    winRate: DIAMOND_CELL.winRate,
  },
  bands: {
    league: [
      { value: 3, label: "Platinum", ...fixtureCell(88, 17, 45) },
      { value: 4, label: "Diamond", ...DIAMOND_CELL },
      { value: 5, label: "Master", ...fixtureCell(97, 14, 50) },
    ],
    mmr: [
      { value: 3500, label: "3500–4000", ...fixtureCell(71, 13, 37) },
      { value: 4000, label: "4000–4500", ...fixtureCell(104, 19, 58) },
      { value: 4500, label: "4500–5000", ...fixtureCell(83, 12, 44) },
    ],
  },
  timings: { samples: TIMING_SAMPLES, users: 58, milestones: FIXTURE_PVZ_MILESTONES },
  army: {
    "360": checkpoint(331, 55, [
      ["Adept", 321, 6],
      ["VoidRay", 271, 1],
      ["Oracle", 212, 1],
      ["Stalker", 136, 1],
      ["Zealot", 78, 1],
    ]),
    "480": checkpoint(302, 52, [
      ["Adept", 299, 14],
      ["VoidRay", 245, 2],
      ["Oracle", 172, 1],
      ["Stalker", 133, 2],
    ]),
    "600": checkpoint(214, 41, [
      ["Adept", 208, 17],
      ["VoidRay", 167, 2],
      ["Stalker", 112, 3],
      ["Archon", 37, 1],
    ]),
  },
  vsStrategy: [
    {
      strategyKey: "Zerg - 17 Hatch 18 Gas 17 Pool",
      strategySlug: "17-hatch-18-gas-17-pool",
      name: "17 Hatch 18 Gas 17 Pool",
      published: true,
      ...fixtureCell(138, 31, 76),
    },
    {
      strategyKey: "ZvP - Hatch First Macro",
      strategySlug: "hatch-first-macro",
      name: "Hatch First Macro",
      published: true,
      ...fixtureCell(96, 22, 49, 1),
    },
    {
      strategyKey: "ZvP - Ling Bane Bust",
      strategySlug: "ling-bane-bust",
      name: "Ling Bane Bust",
      published: false,
      ...fixtureCell(41, 12, 18),
    },
  ],
  lengths: [
    { bucket: "0-6", minSec: 0, maxSec: 360, ...fixtureCell(47, 19, 21) },
    { bucket: "6-10", minSec: 360, maxSec: 600, ...fixtureCell(163, 44, 94, 1) },
    { bucket: "10-15", minSec: 600, maxSec: 900, ...fixtureCell(128, 39, 66) },
    { bucket: "15-20", minSec: 900, maxSec: 1200, ...fixtureCell(52, 21, 24, 1) },
  ],
  maps: [
    { map: "Old Sun Temple", mapSlug: "old-sun-temple", ...fixtureCell(61, 23, 36) },
    { map: "Rainfall", mapSlug: "rainfall", ...fixtureCell(55, 21, 31) },
    { map: "Lockdown", mapSlug: "lockdown", ...fixtureCell(48, 19, 22) },
    { map: "Washout", mapSlug: "washout", ...fixtureCell(44, 18, 20, 1) },
  ],
  macro: { avgScore: 71.4, games: 398, users: 61 },
  leaks: {
    games: 398,
    users: 61,
    items: [
      { name: "Supply Blocked", games: 214, users: 49, share: fixtureShare(214, 398) },
      { name: "Chrono Efficiency", games: 171, users: 44, share: fixtureShare(171, 398) },
      { name: "Mineral Float", games: 96, users: 33, share: fixtureShare(96, 398) },
    ],
  },
  trend: { winRateDelta: 0.0131, prevalenceDelta: 0.0042, since: FIXTURE_BASELINE_AT },
  isNew: false,
  firstPublishedAt: FIXTURE_FIRST_PUBLISHED_AT,
  related: [
    relatedRow("PvZ - Standard Blink Macro", "standard-blink-macro", true, 611, 88, 312),
    relatedRow("PvZ - Adept Glaives (Robo)", "adept-glaives-robo", true, 523, 71, 280),
    relatedRow("PvZ - Robo Opener", "robo-opener", true, 287, 49, 141),
    relatedRow("PvZ - Stargate Opener", "stargate-opener", false, 64, 21, 30),
  ],
  communityBuilds: [{ slug: "pvz-stargate-into-glaives-7f3k", title: STARGATE_GLAIVES }],
  examples: [
    {
      handle: "fixture-player",
      displayName: "FixturePlayer",
      result: "Victory",
      map: "Old Sun Temple",
      durationSec: 604,
      playedAt: "2026-09-25T20:41:09.000Z",
      href: "/players/fixture-player/replays",
    },
  ],
  notes: {
    body: [
      "### Game plan",
      "Lead with a **Void Ray** to clear Overlords, then hide the *Twilight Council*.",
      "",
      "- Scout the natural before committing to `Glaives`",
      "- Move out before the upgrade finishes",
      "",
      "Background: [Adept on Liquipedia](https://liquipedia.net/starcraft2/Adept)",
    ].join("\n"),
    updatedAt: "2026-09-20T18:05:00.000Z",
  },
};

function relatedRow(
  buildKey: string,
  buildSlug: string,
  published: boolean,
  games: number,
  users: number,
  wins: number,
): GuideBuildPublished["related"][number] {
  const cell = fixtureCell(games, users, wins);
  return {
    buildKey,
    buildSlug,
    name: buildKey.slice(buildKey.indexOf(" - ") + " - ".length),
    published,
    games: cell.games,
    winRate: cell.winRate,
    ci: cell.ci,
  };
}

export const FIXTURE_BUILD_UNPUBLISHED: GuideBuildUnpublished = {
  published: false,
  matchup: "PvZ",
  matchupSlug: "pvz",
  buildKey: "PvZ - Carrier Rush",
  buildSlug: "carrier-rush",
  name: "Carrier Rush",
  description: fixtureDescription("PvZ - Carrier Rush"),
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  videos: [VIDEO_PVZ_CARRIER_RUSH],
};
