import { describe, expect, it } from "vitest";
import { visibleDossierTimings } from "../dossierTimings";
import type { DossierAnalysis, DossierTimingRow } from "../dossierTypes";

const row: DossierTimingRow = { sampleCount: 2, medianSeconds: 120, medianDisplay: "2:00", source: "opp_build_log", p25Seconds: 100, p75Seconds: 140, samples: [{ gameId: "a" }, { gameId: "b" }] };
describe("dossier timing compatibility", () => {
  it("combines compatibility medians with rich legacy evidence and preserves server order", () => {
    const data: DossierAnalysis = { medianTimings: { A: { median: 120, count: 2 } }, medianTimingsLegacy: { A: row, B: { ...row, source: "build_log" }, C: { ...row, sampleCount: 1 } }, medianTimingsOrder: ["C", "B", "A"] };
    const theirs = visibleDossierTimings(data, "", "opp_build_log"); expect(theirs.map(item => item.token)).toEqual(["A"]); expect(theirs[0].row.p25Seconds).toBe(100); expect(theirs[0].selection?.gameIds).toEqual(["a", "b"]);
    expect(visibleDossierTimings(data, "", "build_log").map(item => item.token)).toEqual(["B"]);
  });
  it("uses the chosen matchup and bounds deduplicated analyzed IDs without widening missing links", () => {
    const data: DossierAnalysis = { matchupTimingsLegacy: { PvZ: { timings: { A: { ...row, samples: Array.from({ length: 120 }, (_, index) => ({ gameId: `g${index}` })) }, B: { ...row, samples: [{ gameId: null }] } }, order: ["B", "A"] } } };
    const rows = visibleDossierTimings(data, "PvZ", "opp_build_log"); expect(rows[0].selection).toBeNull(); expect(rows[1].selection).toMatchObject({ matchup: "PvZ", source: "opp_build_log", token: "A" }); expect(rows[1].selection?.gameIds).toHaveLength(100);
    expect(visibleDossierTimings(data, "PvT", "opp_build_log")).toEqual([]);
  });
});
