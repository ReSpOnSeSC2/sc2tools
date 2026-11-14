import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInstantPayload } from "@/lib/instant/reportPayload";
import type { BalanceEvidence } from "./evidence";
import { decideReplayVerdict, EARLY_AGGRESSION, replayCases, replayCohort, replayExhibits, replayMap } from "./replayVerdict";
import { ladderShare, readReplayVerdict, replayVerdictPath, type ReplayVerdict } from "./verdictShare";

const evidence: BalanceEvidence = {
  season: 68, asOf: "2026-11-13", maps: [{ id: 3, name: "Blackrock LE" }],
  tiers: [{ league: "diamond", division: 1, bounds: [
    { region: "US", minRating: 3400, maxRating: 3799 }, { region: "EU", minRating: 3700, maxRating: 3849 },
  ], matchups: [], mapMatchups: [] }],
};

function game(extra: Record<string, unknown> = {}) {
  const parsed = parseInstantPayload(JSON.stringify({ gameId: "private-game", date: "2026-10-29T00:20:00Z", result: "Defeat",
    myRace: "Terran", myLadderRace: "Terran", myMmr: 3500, myToonHandle: "1-S2-1-123456", isLadderGame: true,
    map: "Blackrock LE", opponent: { race: "Protoss", leagueId: 3, displayName: "Private player" }, ...extra }));
  if (!parsed) throw new Error("could not parse test fixture");
  return parsed;
}

describe("replay verdict", () => {
  it("requires a ranked non-mirror loss from a supported race", () => {
    expect(replayCases([
      game({ myLadderRace: "Random" }), game({ result: "Victory" }), game({ isLadderGame: false }),
      game({ opponent: { race: "T" } }), game(),
    ])).toMatchObject([{ race: "T", opponent: "P" }]);
  });

  it("uses regional MMR, then the normalized opponent league as a pooled fallback", () => {
    expect(replayCohort(evidence, game())).toEqual({ key: "diamond-1", source: "mmr" });
    expect(replayCohort(evidence, game({ myToonHandle: "2-S2-1-123456" }))).toEqual({ key: "platinum", source: "opponent" });
    expect(replayCohort(evidence, game({ myMmr: 0, opponent: { race: "P", leagueId: 0 } }))).toEqual({ key: "bronze", source: "opponent" });
    expect(replayCohort(evidence, game({ myMmr: 100, opponent: { race: "P", leagueId: 7 } }))).toBeNull();
    expect(replayMap(evidence, "Blackrock LE")).toEqual({ id: 3, name: "Blackrock LE" });
    expect(replayMap({ ...evidence, maps: [...evidence.maps, { id: 4, name: "Blackrock LE" }] }, "Blackrock LE")).toBeNull();
  });

  it("applies the inclusive confidence cutoffs and a strict severity limit", () => {
    const own = { own: [], mirrors: [] };
    expect(decideReplayVerdict({ low: 0.41, high: 0.47 }, { ...own, severity: 39 })).toBe("imba");
    expect(decideReplayVerdict({ low: 0.41, high: 0.47 }, { ...own, severity: 40 })).toBe("split");
    expect(decideReplayVerdict({ low: 0.41, high: 0.47 }, { ...own, severity: null })).toBe("split");
    expect(decideReplayVerdict({ low: 0.44, high: 0.49 }, { ...own, severity: 15 })).toBe("split");
    expect(decideReplayVerdict({ low: 0.51, high: 0.56 }, { ...own, severity: 15 })).toBe("contempt");
    expect(ladderShare(0.4656)).toBeCloseTo(0.06437);
    expect(ladderShare(0.6)).toBe(0);
  });

  it("cross-checks like-for-like autopsy evidence and does not infer a rush from duration", () => {
    const lead = { low: 0.48, high: 0.52 };
    const bothBlocked = replayExhibits(game({ durationSec: 44, macroBreakdown: { raw: {
      supply_blocked_seconds: 25, opp_supply_block_windows: [{ start: 0, end: 35, blocked_sec: 35 }],
    } } }));
    expect(bothBlocked).toMatchObject({ severity: 33, earlyAggression: false, mirrors: [{ opponentSeverity: 47 }] });
    expect(decideReplayVerdict(lead, bothBlocked)).toBe("insufficient");
    const youBlocked = replayExhibits(game({ macroBreakdown: { raw: { supply_blocked_seconds: 25, opp_supply_block_windows: [] } } }));
    expect(decideReplayVerdict(lead, youBlocked)).toBe("replay");
    expect(replayExhibits(game()).severity).toBeNull();
  });

  it("pins the rush labels to the replay engine and requires a classified proxy", () => {
    const detector = readFileSync(resolve(process.cwd(), "../replay-engine/core/strategy_detector_race.py"), "utf8");
    for (const strategy of EARLY_AGGRESSION) {
      expect(detector).toContain(`return "${strategy}"`);
      expect(replayExhibits(game({ opponent: { race: "P", strategy } })).earlyAggression).toBe(true);
    }
    expect(replayExhibits(game({ spatial: { opp_proxy_classification_v: 2, opp_proxies: [{ name: "Barracks" }] } })).earlyAggression).toBe(true);
    expect(replayExhibits(game({ spatial: { opp_proxy_classification_v: 1, opp_proxies: [{ name: "Barracks" }] } })).earlyAggression).toBe(false);
  });

  it("shares only allow-listed fields in a fragment and rejects malformed or unexpected data", () => {
    const summary: ReplayVerdict = { season: 68, asOf: "2026-11-13", race: "T", opponent: "P", cohort: "diamond-1", verdict: "imba", mapId: 3 };
    const path = replayVerdictPath({ ...game(), ...summary });
    const hash = path.slice(path.indexOf("#"));
    expect(path).toBe("/balance/verdict#verdict=imba&season=68&asOf=2026-11-13&race=T&opponent=P&cohort=diamond-1&map=3");
    expect(readReplayVerdict(hash)).toEqual(summary);
    expect(readReplayVerdict(`${hash}&replay=private-game`)).toBeNull();
    expect(readReplayVerdict(`${hash}&race=T`)).toBeNull();
    expect(readReplayVerdict(hash.replace("map=3", "map=3.1"))).toBeNull();
  });
});
