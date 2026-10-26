import type { BuildExecution } from "@/lib/buildExecution";
export function executionFixture(): BuildExecution {
  return { build: { name: "Private Stargate", slug: "stargate", source: "custom", race: "Protoss", vsRace: "Zerg", rules: [{ type: "count_min", name: "BuildStargate", time_lt: 300, count: 2 }] },
    source: "confirmed", matchup: "PvZ", ruleCount: 2, knownCount: 2, passedCount: 1, matchPct: 50,
    rules: [{ index: 0, name: "BuildStargate", type: "count_min", sentence: "Stargate: needed at least 2 before 5:00; had 2", pass: true, unavailable: false, got: 2, need: 2, deadlineSec: 300, evidenceSec: 290, evidenceKind: "event" },
      { index: 1, name: "BuildNexus", type: "count_min", sentence: "Nexus: needed at least 3 before 6:00; had 2", pass: false, unavailable: false, got: 2, need: 3, deadlineSec: 360, evidenceSec: 360, evidenceKind: "deadline" }],
    timings: [{ token: "Nexus", displayName: "Nexus", kind: "natural", thisGameSec: 140, medianSec: 120, p25Sec: 110, p75Sec: 135, n: 3, deltaSec: 20 },
      { token: "Assimilator", displayName: "Assimilator", kind: "first_gas", thisGameSec: 50, medianSec: 55, p25Sec: 45, p75Sec: 60, n: 4, deltaSec: -5 },
      { token: "CyberneticsCore", displayName: "Cybernetics Core", kind: "first_tech", thisGameSec: 100, medianSec: null, p25Sec: null, p75Sec: null, n: 2, deltaSec: null }],
    timingMinSample: 3, timingSampleSelected: 25, timingSampleGames: 20, timingSampleLimit: 25 };
}
