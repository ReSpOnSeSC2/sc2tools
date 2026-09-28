/**
 * reportMmr — pre-game MMR, the change up to your next ladder game and
 * the per-queue journey, on real payloads (fixtures/reportGames.ts).
 * Derived variants (re-dated, other queue/account) are labelled inline.
 */
import { describe, expect, it } from "vitest";

import {
  computeMmrByQueue,
  formatMmr,
  ladderQueues,
  mmrGapLabel,
  nextGameMmrChanges,
  preGameMmr,
  signedMmr,
} from "../reportMmr";
import type { InstantPayload } from "../reportPayload";
import { bare, ladderPair, realWin } from "./fixtures/reportGames";

/** Derived: the older real ladder game moved to another date/id. */
function olderAt(gameId: string, date: string, patch: Partial<InstantPayload> = {}): InstantPayload {
  return { ...ladderPair()[0], gameId, date, ...patch };
}

describe("preGameMmr", () => {
  it("reads both real pre-game MMRs and the gap", () => {
    expect(preGameMmr(realWin())).toEqual({ my: 5326, opp: 5118, gap: 208 });
    const [older] = ladderPair();
    expect(preGameMmr(older)).toEqual({ my: 3703, opp: 3594, gap: 109 });
  });

  it("is null unless both MMRs come from the replay", () => {
    const win = realWin();
    expect(preGameMmr({ ...win, myMmr: null })).toBeNull();
    expect(preGameMmr({ ...win, myMmrSource: "unavailable" })).toBeNull();
    expect(preGameMmr({ ...win, opponent: null })).toBeNull();
    const opponent = win.opponent ? { ...win.opponent, mmrSource: "pulse" } : null;
    expect(preGameMmr({ ...win, opponent })).toBeNull();
  });
});

describe("nextGameMmrChanges", () => {
  it("measures the real change up to the next game on the same account and queue", () => {
    const [older, newer] = ladderPair();
    const changes = nextGameMmrChanges([newer, older]);
    expect(changes.get(older.gameId)).toEqual({ delta: 3671 - 3703, nextGameId: newer.gameId });
    // The newest game has no later game here, so no change is claimed.
    expect(changes.has(newer.gameId)).toBe(false);
  });

  it("orders by date, not input order, and chains every game", () => {
    const [, newer] = ladderPair();
    const middle = olderAt("mid", "2026-03-10T12:00:00Z", { myMmr: 3750 });
    const first = olderAt("first", "2026-01-05T12:00:00Z", { myMmr: 3600 });
    const changes = nextGameMmrChanges([newer, middle, first]);
    expect(changes.get("first")).toEqual({ delta: 150, nextGameId: "mid" });
    expect(changes.get("mid")).toEqual({ delta: 3671 - 3750, nextGameId: newer.gameId });
    expect(changes.size).toBe(2);
  });

  it("never pairs games from different queues or accounts", () => {
    const [, newer] = ladderPair();
    const otherQueue = olderAt("random-queue", "2026-03-01T00:00:00Z", { myLadderRace: "Random" });
    const otherAccount = olderAt("eu-account", "2026-03-02T00:00:00Z", { myToonHandle: "2-S2-1-111" });
    expect(nextGameMmrChanges([newer, otherQueue, otherAccount]).size).toBe(0);
  });

  it("leaves out non-ladder games, missing MMRs and bad dates", () => {
    const [, newer] = ladderPair();
    const unranked = olderAt("unranked", "2026-03-01T00:00:00Z", { isLadderGame: false });
    const unknown = olderAt("unknown", "2026-03-02T00:00:00Z", { isLadderGame: null });
    const noMmr = olderAt("no-mmr", "2026-03-03T00:00:00Z", { myMmr: null });
    const noQueue = olderAt("no-queue", "2026-03-04T00:00:00Z", { myLadderRace: null });
    const undated = olderAt("undated", "not a date");
    expect(nextGameMmrChanges([newer, unranked, unknown, noMmr, noQueue, undated]).size).toBe(0);
    expect([...ladderQueues([newer, unranked, undated]).values()].map((q) => q.length)).toEqual([1]);
  });
});

describe("computeMmrByQueue", () => {
  it("reports first → latest, net change and peak for the real pair", () => {
    const [older, newer] = ladderPair();
    expect(computeMmrByQueue([newer, older])).toEqual([
      {
        toonHandle: "5-S2-1-526043",
        region: "CN",
        accountLabel: "CN 526043",
        race: "Terran",
        games: 2,
        start: 3703,
        end: 3671,
        peak: 3703,
        delta: -32,
      },
    ]);
  });

  it("keeps queues apart and needs two games per queue", () => {
    const [older, newer] = ladderPair();
    const random = (id: string, date: string, mmr: number) => olderAt(id, date, { myLadderRace: "Random", myMmr: mmr });
    const rows = computeMmrByQueue([
      older,
      newer,
      random("r1", "2026-01-01T00:00:00Z", 3000),
      random("r2", "2026-01-02T00:00:00Z", 3100),
      random("r3", "2026-01-03T00:00:00Z", 3050),
      realWin(),
    ]);
    expect(rows?.map((row) => [row.race, row.games, row.start, row.end, row.peak, row.delta])).toEqual([
      ["Random", 3, 3000, 3050, 3100, 50],
      ["Terran", 2, 3703, 3671, 3703, -32],
    ]);
  });

  it("is null when no queue has two ladder games with a replay MMR", () => {
    const [older, newer] = ladderPair();
    expect(computeMmrByQueue([realWin()])).toBeNull();
    expect(computeMmrByQueue([older, { ...newer, isLadderGame: false }])).toBeNull();
    expect(computeMmrByQueue([bare(), bare({ gameId: "h" })])).toBeNull();
  });
});

describe("MMR labels", () => {
  it("formats values, signed changes and the gap", () => {
    expect(formatMmr(5326)).toBe("5,326");
    expect(signedMmr(18)).toBe("+18");
    expect(signedMmr(-1032)).toBe("−1,032");
    expect(signedMmr(0)).toBe("±0");
    expect(mmrGapLabel(208)).toBe("favored by 208");
    expect(mmrGapLabel(-90)).toBe("underdog by 90");
    expect(mmrGapLabel(0)).toBe("even match");
  });
});
