import { describe, expect, it } from "vitest";
import { getBalanceCohort, readBalanceEvidence, readBalancePin } from "./evidence";
import { evaluatePermit, parsePermitNumber } from "./permit";
import { wilsonInterval } from "../wilson";
import { balanceEvidenceFixture } from "../../tests/e2e/balance-evidence-fixture";

describe("ladder evidence", () => {
  it("pools distinct same-tier games and orients wins for either race", () => {
    const evidence = balanceEvidenceFixture();
    expect(readBalanceEvidence(evidence)).toEqual(evidence);
    expect(getBalanceCohort(evidence, "diamond", "T", "P")).toMatchObject({ matchup: "PvT", games: 3000, wins: 1410, winRate: 0.47, confidence: 95 });
    expect(getBalanceCohort(evidence, "diamond-1", "T", "P", 5)).toMatchObject({ games: 500, wins: 200, confidence: 99 });
    expect(getBalanceCohort(evidence, "diamond", "T", "T")).toBeNull();
    expect(getBalanceCohort(evidence, "diamond", "T", "P", 999)).toBeNull();
  });

  it("rejects duplicate cohorts, invalid map references and inexact snapshot pins", () => {
    const evidence = balanceEvidenceFixture();
    expect(readBalanceEvidence({ ...evidence, tiers: [evidence.tiers[1], ...evidence.tiers.slice(1)] })).toBeNull();
    evidence.tiers[0].mapMatchups[0].mapId = 6;
    expect(readBalanceEvidence(evidence)).toBeNull();
    expect(readBalancePin(new URLSearchParams("season=68&asOf=2026-11-13"))).toEqual({ season: 68, asOf: "2026-11-13" });
    for (const value of ["season=68&asOf=2026-11-31", "season=68&season=69&asOf=2026-11-13", "season=68", "asOf=2026-11-13"]) {
      expect(readBalancePin(new URLSearchParams(value))).toBeNull();
    }
  });

  it("matches the API's 95% and 99% intervals at API precision", () => {
    const asApi = (z: number) => Object.fromEntries(Object.entries(wilsonInterval(60, 100, z)!).map(([edge, value]) => [edge, Number(value.toFixed(4))]));
    expect(asApi(1.96)).toEqual({ low: 0.502, high: 0.6906 });
    expect(asApi(2.58)).toEqual({ low: 0.4712, high: 0.7163 });
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(2, 1)).toBeNull();
  });
});

describe("Whine Permit", () => {
  it("caps the ladder's contribution at the player's deficit", () => {
    const evidence = balanceEvidenceFixture();
    const result = evaluatePermit(evidence, "diamond", "T", "P", 49, 51);
    expect(result?.status).toBe("Licensed to whine");
    expect(result?.ladderGap).toBeCloseTo(0.01);
    expect(result?.playerGap).toBe(0);
    const denied = evaluatePermit(evidence, "diamond-1", "P", "T", 40, 60);
    expect(denied?.status).toBe("Permit denied");
    expect(denied?.ladderGap).toBe(0);
    expect(denied?.playerGap).toBeCloseTo(0.1);
    expect(evaluatePermit(evidence, "diamond", "T", "P", 51, 49)?.status).toBe("No losing record");
  });

  it("accepts only bounded whole win and loss counts", () => {
    for (const invalid of ["", "-1", "1.5", "1e5", "100001", " 1"]) expect(parsePermitNumber(invalid)).toBeNull();
    expect(parsePermitNumber("0")).toBe(0);
    expect(parsePermitNumber("100000")).toBe(100000);
    const evidence = balanceEvidenceFixture();
    expect(evaluatePermit(evidence, "diamond", "P", "T", 0, 0)).toBeNull();
    expect(evaluatePermit(evidence, "diamond", "P", "T", 100000, 1)).toBeNull();
  });
});
