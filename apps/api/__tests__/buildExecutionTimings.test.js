// @ts-nocheck
"use strict";
const { naturalTimingBaselines, executionTimings, MIN_SAMPLE } = require("../src/services/buildExecutionTimings");
const { compactDossierTimingLog } = require("../src/services/buildDossierTimingSample");
const { eventsToStartTime, parseBuildLogLines } = require("../src/services/perGameCompute");
const { computeDossierExtras } = require("../src/services/buildDossier");
const at = new Date("2026-10-20");
function game(offset = 0, patch = {}) {
  const row = { date: at, myRace: "Protoss", opponent: { race: "Zerg" },
    buildLog: ["[0:00] Nexus", `[2:${String(offset).padStart(2, "0")}] Nexus`, "[0:45] Assimilator", "[1:30] CyberneticsCore", "[3:00] WarpGate"], ...patch };
  row.buildLog = compactDossierTimingLog(row.buildLog, row);
  return row;
}
test("compaction preserves a natural alongside the starting base and keeps the earliest unordered expansion", () => {
  const compact = compactDossierTimingLog(["[0:00] Nexus", "[4:00] Nexus", "[2:00] Nexus", "[3:00] Nexus"]);
  expect(compact).toEqual(["[0:00] Nexus", "[2:00] Nexus"]);
});
test("natural baseline uses only the first expansion after10s and actual matchup observations", () => {
  const rows = [...Array.from({ length: 5 }, (_, i) => game(i * 10)), game(0, { opponent: { race: "Terran" } })];
  const result = naturalTimingBaselines(rows);
  expect(result.PvZ).toMatchObject({ token: "Nexus", sampleCount: 5, medianSeconds: 140, p25Seconds: 130, p75Seconds: 150 });
  expect(result.PvT.sampleCount).toBe(1);
  expect(naturalTimingBaselines([game(0, { buildLog: ["[0:00] Nexus"] })])).toEqual({});
});
test("the same normalized source supplies natural, first gas/tech and only first building occurrences", () => {
  const rows = Array.from({ length: 5 }, (_, i) => game(i * 10));
  const dossier = { ...computeDossierExtras(rows), naturalTimings: naturalTimingBaselines(rows) };
  const events = eventsToStartTime(parseBuildLogLines(["[0:00] Nexus", "[2:20] Nexus", "[0:50] Assimilator", "[1:40] CyberneticsCore", "[3:00] WarpGate", "[4:00] CyberneticsCore"]));
  const result = executionTimings(dossier, "PvZ", events);
  expect(MIN_SAMPLE).toBe(3);
  expect(result.find(row => row.kind === "natural")).toMatchObject({ thisGameSec: 140, medianSec: 140, n: 5, deltaSec: 0 });
  expect(result.find(row => row.kind === "first_gas")).toMatchObject({ token: "Assimilator", thisGameSec: 50, medianSec: 45, deltaSec: 5 });
  expect(result.find(row => row.kind === "first_tech")).toMatchObject({ token: "CyberneticsCore", thisGameSec: 100, medianSec: 90, deltaSec: 10 });
  expect(result.filter(row => row.token === "CyberneticsCore")).toHaveLength(1);
  expect(result.find(row => row.token === "WarpGate").thisGameSec).toBeLessThan(180);
  expect(JSON.stringify(result)).not.toMatch(/gameId|buildLog|samples/);
});
test("two observations stay hidden and three show the private comparison", () => {
  const dossier = { matchupTimingsLegacy: { PvZ: { timings: { Assimilator: { sampleCount: 2, medianSeconds: 45, p25Seconds: 40, p75Seconds: 50 } } } } };
  const events = [{ name: "Assimilator", is_building: true, time: 50 }];
  expect(executionTimings(dossier, "PvZ", events)[0]).toMatchObject({ n: 2, medianSec: null, p25Sec: null, p75Sec: null, deltaSec: null });
  dossier.matchupTimingsLegacy.PvZ.timings.Assimilator.sampleCount = 3;
  expect(executionTimings(dossier, "PvZ", events)[0]).toMatchObject({ n: 3, medianSec: 45, p25Sec: 40, p75Sec: 50, deltaSec: 5 });
});
