import { expect, it } from "vitest";
import { checkedMatchPercentage, executionTimingDeltas } from "./buildExecution";
import { normalizeBuildEvents } from "./build-events";
import { executionFixture } from "@/components/analyzer/game/__tests__/buildExecutionFixtures";
it("withholds percentages for unknown/empty/unavailable evidence, retaining genuine zero", () => {
  const data = executionFixture(); expect(checkedMatchPercentage(data)).toBe(50);
  data.matchPct = 0; expect(checkedMatchPercentage(data)).toBe(0);
  data.knownCount = 1; expect(checkedMatchPercentage(data)).toBeNull();
  data.knownCount = 2; data.unavailable = "log_missing"; expect(checkedMatchPercentage(data)).toBeNull();
  data.unavailable = undefined; data.ruleCount = 0; expect(checkedMatchPercentage(data)).toBeNull();
});
it("uses the identical private three-observation floor and matches a natural instead of the starting base or repeats", () => {
  const rows = normalizeBuildEvents([{ time: 0, name: "Nexus", category: "building" }, { time: 140, name: "Nexus", category: "building" }, { time: 240, name: "Nexus", category: "building" }, { time: 100, name: "CyberneticsCore", category: "building" }]);
  const data = executionFixture(), deltas = executionTimingDeltas(rows, data.timings, "PvZ");
  expect([...deltas.keys()]).toEqual([rows[1].key]); expect(deltas.get(rows[1].key)?.label).toBe("+20s vs your median");
  data.timings[0].n = 2; expect(executionTimingDeltas(rows, data.timings, "PvZ").size).toBe(0);
  expect(executionTimingDeltas(rows, data.timings, null).size).toBe(0);
});
