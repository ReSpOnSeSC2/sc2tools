/**
 * Render sweep for the classic payload-driven overlay widgets — every
 * widget that previously had no dedicated component test. Each case
 * feeds the SAME payload shape the API's Test button emits
 * (apps/api/src/services/overlayLiveSamples.js FULL) and asserts a
 * distinctive datum lands in the DOM; the null-payload case asserts
 * the widget stays silent. This pins the widget ↔ sample-payload
 * contract from the client side: a renamed payload field now fails
 * here instead of silently blanking a Test fire.
 */

import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { LiveGamePayload } from "@/components/overlay/types";
import {
  BestAnswerWidget,
  CheeseWidget,
  FavOpeningWidget,
  MatchResultWidget,
  MetaWidget,
  MmrDeltaWidget,
  PostGameWidget,
  RankWidget,
  RematchWidget,
  RivalWidget,
  SessionWidget,
  StreakWidget,
  TopBuildsWidget,
} from "../PrePostFlow";

afterEach(cleanup);

/** Mirror of the API sample payload (overlayLiveSamples.js FULL). */
const FULL: LiveGamePayload = {
  myRace: "Protoss",
  oppRace: "Zerg",
  oppName: "TestOpponent",
  map: "Goldenaura LE",
  matchup: "PvZ",
  result: "win",
  durationSec: 612,
  oppMmr: 4250,
  myMmr: 4310,
  mmrDelta: 22,
  headToHead: { wins: 4, losses: 2 },
  streak: { kind: "win", count: 3 },
  cheeseProbability: 0.65,
  predictedStrategies: [
    { name: "Pool first", weight: 0.45 },
    { name: "Hatch first", weight: 0.35 },
  ],
  topBuilds: [
    { name: "P - Stargate", total: 14, winRate: 0.71 },
    { name: "P - 4 Gate", total: 9, winRate: 0.55 },
  ],
  bestAnswer: { build: "P - Stargate", winRate: 0.78, total: 7 },
  favOpening: { name: "Pool first", share: 0.55, samples: 11 },
  session: {
    wins: 4,
    losses: 4,
    games: 8,
    mmrStart: 5320,
    mmrCurrent: 5343,
    region: "NA",
    streak: { kind: "win", count: 2 },
  },
  rank: { league: "Diamond", tier: 1, mmr: 4310 },
  meta: {
    matchup: "PvZ",
    topBuilds: [
      { name: "Pool first", share: 0.55 },
      { name: "Hatch first", share: 0.35 },
    ],
  },
  rival: {
    name: "TestOpponent",
    headToHead: { wins: 4, losses: 2 },
    note: "Frequent matchup",
  },
  rematch: { isRematch: true, lastResult: "win" },
} as LiveGamePayload;

type Case = {
  name: string;
  element: (live: LiveGamePayload | null) => React.ReactElement;
  /** Substrings that must appear with the sample payload. */
  expects: string[];
};

const CASES: Case[] = [
  {
    name: "MatchResultWidget",
    element: (live) => <MatchResultWidget live={live} />,
    expects: ["Goldenaura"],
  },
  {
    name: "PostGameWidget",
    element: (live) => <PostGameWidget live={live} />,
    expects: ["Goldenaura"],
  },
  {
    name: "MmrDeltaWidget",
    element: (live) => <MmrDeltaWidget live={live} />,
    expects: ["22"],
  },
  {
    name: "StreakWidget",
    element: (live) => <StreakWidget live={live} />,
    expects: ["3"],
  },
  {
    name: "CheeseWidget",
    element: (live) => <CheeseWidget live={live} />,
    expects: ["65"],
  },
  {
    name: "RematchWidget",
    element: (live) => <RematchWidget live={live} />,
    expects: ["TestOpponent"],
  },
  {
    name: "RivalWidget",
    element: (live) => <RivalWidget live={live} />,
    expects: ["TestOpponent"],
  },
  {
    name: "RankWidget",
    element: (live) => <RankWidget live={live} />,
    expects: ["Diamond"],
  },
  {
    name: "MetaWidget",
    element: (live) => <MetaWidget live={live} />,
    expects: ["Pool first"],
  },
  {
    name: "TopBuildsWidget",
    element: (live) => <TopBuildsWidget live={live} />,
    expects: ["P - Stargate"],
  },
  {
    name: "FavOpeningWidget",
    element: (live) => <FavOpeningWidget live={live} />,
    expects: ["Pool first"],
  },
  {
    name: "BestAnswerWidget",
    element: (live) => <BestAnswerWidget live={live} />,
    expects: ["P - Stargate"],
  },
  {
    name: "SessionWidget",
    element: (live) => (
      <SessionWidget live={live} session={live ? live.session ?? null : null} />
    ),
    expects: ["5343"],
  },
];

describe.each(CASES)("$name", ({ element, expects }) => {
  test("renders the sample payload's data", () => {
    const { container } = render(element(FULL));
    const text = container.textContent ?? "";
    for (const needle of expects) {
      expect(text).toContain(needle);
    }
  });

  test("stays silent with no payload", () => {
    const { container } = render(element(null));
    const text = container.textContent ?? "";
    for (const needle of expects) {
      expect(text).not.toContain(needle);
    }
  });
});
