import { describe, expect, test } from "vitest";
import {
  guideBuildSlug,
  guideDisplayName,
  guideSlugify,
  guideStrategySlug,
} from "@/lib/guides/slugs";
import * as fixtures from "@/lib/guides/__fixtures__";
import type { GuideCell, GuideMatchup } from "@/lib/guides/types";

// Page tests rely on these fixtures being contract-true: real catalog
// names and slugs, cells that clear the floor, consistent intervals, and
// number-free unpublished payloads.
const CELL_MIN_GAMES = 30;
const CELL_MIN_USERS = 5;
const PAGE_MIN_GAMES = 100;

function isCell(value: unknown): value is GuideCell {
  return (
    typeof value === "object" &&
    value !== null &&
    "ci" in value &&
    "games" in value &&
    "wins" in value
  );
}

type Visit = (node: Record<string, unknown>, matchup: GuideMatchup) => void;

/** Depth-first walk that carries the nearest enclosing `matchup`. */
function walk(value: unknown, visit: Visit, matchup: GuideMatchup = "PvZ"): void {
  if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit, matchup));
  else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const scoped = typeof node.matchup === "string" ? (node.matchup as GuideMatchup) : matchup;
    visit(node, scoped);
    Object.values(node).forEach((entry) => walk(entry, visit, scoped));
  }
}

function hasNumber(value: unknown): boolean {
  let found = false;
  walk({ value }, (node) => {
    if (Object.values(node).some((entry) => typeof entry === "number")) found = true;
  });
  return found;
}

const PAYLOADS = {
  index: fixtures.FIXTURE_INDEX,
  matchup: fixtures.FIXTURE_MATCHUP,
  matchupBand: fixtures.FIXTURE_MATCHUP_BAND,
  build: fixtures.FIXTURE_BUILD_PUBLISHED,
  counter: fixtures.FIXTURE_COUNTER_PUBLISHED,
  map: fixtures.FIXTURE_MAP,
};

describe("guide fixtures stay contract-true", () => {
  test.each(Object.entries(PAYLOADS))("%s: every cell clears the floor with a sane CI", (_, payload) => {
    walk(payload, (node) => {
      if (!isCell(node)) return;
      expect(node.games).toBeGreaterThanOrEqual(CELL_MIN_GAMES);
      expect(node.users).toBeGreaterThanOrEqual(CELL_MIN_USERS);
      expect(node.wins).toBeLessThanOrEqual(node.games);
      expect(node.ci.low).toBeLessThanOrEqual(node.winRate);
      expect(node.winRate).toBeLessThanOrEqual(node.ci.high);
      expect(node.ci.low).toBeGreaterThanOrEqual(0);
      expect(node.ci.high).toBeLessThanOrEqual(1);
    });
  });

  test.each(Object.entries(PAYLOADS))("%s: build and strategy slugs match lib/guides/slugs", (_, payload) => {
    walk(payload, (node, matchup) => {
      if (typeof node.buildKey === "string" && typeof node.buildSlug === "string") {
        expect(guideBuildSlug(matchup, node.buildKey)).toBe(node.buildSlug);
        if (typeof node.name === "string") expect(node.name).toBe(guideDisplayName(node.buildKey));
      }
      if (typeof node.strategyKey === "string") {
        expect(guideStrategySlug(matchup, node.strategyKey)).toBe(node.strategySlug);
      }
      if (typeof node.map === "string" && typeof node.mapSlug === "string") {
        expect(guideSlugify(node.map)).toBe(node.mapSlug);
      }
    });
  });

  test("published pages clear the page floor", () => {
    expect(fixtures.FIXTURE_BUILD_PUBLISHED.overall.games).toBeGreaterThanOrEqual(PAGE_MIN_GAMES);
    expect(fixtures.FIXTURE_COUNTER_PUBLISHED.overall.games).toBeGreaterThanOrEqual(PAGE_MIN_GAMES);
    expect(fixtures.FIXTURE_MAP.games).toBeGreaterThanOrEqual(PAGE_MIN_GAMES);
  });

  test("unpublished payloads carry no numbers at all", () => {
    for (const payload of [
      fixtures.FIXTURE_BUILD_UNPUBLISHED,
      fixtures.FIXTURE_COUNTER_UNPUBLISHED,
      fixtures.FIXTURE_MAP_UNPUBLISHED,
    ]) {
      expect(hasNumber(payload)).toBe(false);
    }
  });

  test("ranked lists are ci.low desc", () => {
    const lists: GuideCell[][] = [
      fixtures.FIXTURE_MATCHUP.openers,
      fixtures.FIXTURE_MATCHUP_BAND.openers,
      fixtures.FIXTURE_COUNTER_PUBLISHED.openers,
      ...fixtures.FIXTURE_MAP.matchups.map((row) => row.openers),
    ];
    for (const list of lists) {
      const lows = list.map((row) => row.ci.low);
      expect(lows).toEqual([...lows].sort((a, b) => b - a));
    }
  });

  test("sitemap paths are site guide paths", () => {
    for (const entry of fixtures.FIXTURE_SITEMAP.entries) {
      expect(entry.path).toMatch(/^\/guides(\/[a-z0-9-]+)*$/);
    }
  });
});
