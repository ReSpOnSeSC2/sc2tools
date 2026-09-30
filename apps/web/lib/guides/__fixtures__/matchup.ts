/**
 * TEST FIXTURES ONLY — `GET /v1/guides/:matchup` payloads for PvZ, with
 * and without an opponent-band filter (league:4 = Diamond).
 */
import {
  FIXTURE_BASELINE_AT,
  FIXTURE_COMPUTED_AT,
  FIXTURE_PATCH,
  fixtureCell,
  fixtureShare,
} from "@/lib/guides/__fixtures__/cells";
import {
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_CRACKING_8_POOLS,
  VIDEO_PVZ_STARGATE_GLAIVES,
} from "@/lib/guides/__fixtures__/videos";
import type { GuideCell, GuideMatchupPayload, GuideOpenerRow, GuideTrend } from "@/lib/guides/types";

const PVZ_GAMES = 6840;

interface OpenerSeed {
  buildKey: string;
  buildSlug: string;
  published: boolean;
  cell: GuideCell;
  trend: GuideTrend;
}

function opener(seed: OpenerSeed, withPrevalence: boolean): GuideOpenerRow {
  return {
    ...seed.cell,
    buildKey: seed.buildKey,
    buildSlug: seed.buildSlug,
    name: seed.buildKey.slice(seed.buildKey.indexOf(" - ") + " - ".length),
    published: seed.published,
    prevalence: withPrevalence ? fixtureShare(seed.cell.games, PVZ_GAMES) : null,
    trend: seed.trend,
    isNew: false,
  };
}

function byCiLowDesc(a: GuideOpenerRow, b: GuideOpenerRow): number {
  return b.ci.low - a.ci.low;
}

const OVERALL_SEEDS: OpenerSeed[] = [
  {
    buildKey: "PvZ - Standard Blink Macro",
    buildSlug: "standard-blink-macro",
    published: true,
    cell: fixtureCell(611, 88, 312),
    trend: { winRateDelta: -0.0047, prevalenceDelta: 0.0011, since: FIXTURE_BASELINE_AT },
  },
  {
    buildKey: "PvZ - Adept Glaives (Robo)",
    buildSlug: "adept-glaives-robo",
    published: true,
    cell: fixtureCell(523, 71, 280, 1),
    trend: { winRateDelta: -0.0212, prevalenceDelta: -0.0036, since: FIXTURE_BASELINE_AT },
  },
  {
    buildKey: "PvZ - Stargate into Glaives",
    buildSlug: "stargate-into-glaives",
    published: true,
    cell: fixtureCell(412, 63, 221, 2),
    trend: { winRateDelta: 0.0131, prevalenceDelta: 0.0042, since: FIXTURE_BASELINE_AT },
  },
  {
    buildKey: "PvZ - Robo Opener",
    buildSlug: "robo-opener",
    published: true,
    cell: fixtureCell(287, 49, 141),
    trend: null,
  },
  {
    buildKey: "PvZ - Stargate Opener",
    buildSlug: "stargate-opener",
    published: false,
    cell: fixtureCell(64, 21, 30),
    trend: null,
  },
  {
    buildKey: "PvZ - Carrier Rush",
    buildSlug: "carrier-rush",
    published: false,
    cell: fixtureCell(43, 9, 19),
    trend: null,
  },
];

/** Diamond band cells for the builds that clear the cell floor there. */
const DIAMOND_SEEDS: OpenerSeed[] = [
  { ...OVERALL_SEEDS[0], cell: fixtureCell(203, 30, 101) },
  { ...OVERALL_SEEDS[1], cell: fixtureCell(171, 26, 94) },
  { ...OVERALL_SEEDS[2], cell: fixtureCell(146, 24, 82, 1) },
  { ...OVERALL_SEEDS[3], cell: fixtureCell(77, 15, 36) },
];

const PVZ_BASE: Omit<GuideMatchupPayload, "band" | "openers"> = {
  matchup: "PvZ",
  slug: "pvz",
  era: "after",
  patch: FIXTURE_PATCH,
  computedAt: FIXTURE_COMPUTED_AT,
  published: true,
  games: PVZ_GAMES,
  users: 511,
  bandOptions: {
    league: [
      { value: 3, label: "Platinum" },
      { value: 4, label: "Diamond" },
      { value: 5, label: "Master" },
    ],
    mmr: [
      { value: 3500, label: "3500–4000" },
      { value: 4000, label: "4000–4500" },
      { value: 4500, label: "4500–5000" },
    ],
  },
  counters: [
    {
      strategyKey: "Zerg - 17 Hatch 18 Gas 17 Pool",
      strategySlug: "17-hatch-18-gas-17-pool",
      name: "17 Hatch 18 Gas 17 Pool",
      published: true,
      games: 1904,
    },
    {
      strategyKey: "ZvP - Hatch First Macro",
      strategySlug: "hatch-first-macro",
      name: "Hatch First Macro",
      published: true,
      games: 1311,
    },
    { strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool", name: "12 Pool", published: true, games: 236 },
    {
      strategyKey: "ZvP - Ling Bane Bust",
      strategySlug: "ling-bane-bust",
      name: "Ling Bane Bust",
      published: false,
      games: 88,
    },
    {
      strategyKey: "ZvP - Lurker Contain",
      strategySlug: "lurker-contain",
      name: "Lurker Contain",
      published: false,
      games: null,
    },
  ],
  videos: [VIDEO_PVZ_CARRIER_RUSH, VIDEO_PVZ_STARGATE_GLAIVES, VIDEO_PVZ_CRACKING_8_POOLS],
};

export const FIXTURE_MATCHUP: GuideMatchupPayload = {
  ...PVZ_BASE,
  band: null,
  openers: OVERALL_SEEDS.map((seed) => opener(seed, true)).sort(byCiLowDesc),
};

export const FIXTURE_MATCHUP_BAND: GuideMatchupPayload = {
  ...PVZ_BASE,
  band: { type: "league", value: 4, label: "Diamond" },
  openers: DIAMOND_SEEDS.map((seed) => opener(seed, false)).sort(byCiLowDesc),
};
