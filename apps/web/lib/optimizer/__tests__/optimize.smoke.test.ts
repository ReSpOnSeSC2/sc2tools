import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import { evaluateCandidate, optimize } from "../search/optimize";
import { defaultPolicies } from "../sim/engine";
import { threatCatalog } from "../threats/store";
import type { OptimizeProgress, OptimizeRequest } from "../types";

const catalog = threatCatalog(null);
const eightPool = catalog.find((t) => t.id === "z-8pool")!;

function request(overrides: Partial<OptimizeRequest> = {}): OptimizeRequest {
  return {
    profileId: "5.0.16",
    race: "Protoss",
    vsRace: "Zerg",
    objective: { id: "earliest-safe-expansion", atSec: 360 },
    threats: [{ threat: eightPool, probability: 0.85 }],
    policies: defaultPolicies(),
    safety: { hasWall: true, allowWorkerPull: true },
    seed: 1337,
    budget: { maxGenerations: 15, maxMillis: 30_000 },
    horizonSec: 360,
    ...overrides,
  };
}

describe("balanced and tech-goal objectives", () => {
  const profile = resolveProfile("5.0.16");
  const pvzAtPriors = () =>
    catalog
      .filter(
        (t) => t.attackerRace === "Zerg" && t.vsDefender.includes("Protoss"),
      )
      .map((threat) => ({ threat, probability: threat.priorProbability }));

  it(
    "balanced macro threads economy, tech, and army together",
    { timeout: 60_000 },
    async () => {
      const result = await optimize(
        request({
          objective: { id: "balanced-development", atSec: 360 },
          threats: pvzAtPriors(),
          budget: { maxGenerations: 40, maxMillis: 30_000 },
          horizonSec: 420,
        }),
      );
      // economy: an expansion on a normal timing, healthy worker count
      const expansions = result.sim.completionTimes.Nexus ?? [];
      expect(expansions.length).toBeGreaterThan(0);
      expect(expansions[0]).toBeLessThan(300);
      expect(result.sim.finalWorkers).toBeGreaterThanOrEqual(30);
      // tech: at least two gated tech structures completed
      const techStructures = Object.keys(result.sim.completionTimes).filter(
        (name) => {
          const def = profile.units[name];
          return def?.isStructure && (def.requires?.length ?? 0) > 0;
        },
      );
      expect(techStructures.length).toBeGreaterThanOrEqual(2);
      // army: actual combat units, not a worker-only corner build
      const combatCount = Object.entries(result.sim.unitsAtEnd)
        .filter(([name]) => {
          const def = profile.units[name];
          return def?.combat && !def.isWorker && !def.isStructure;
        })
        .reduce((sum, [, count]) => sum + count, 0);
      expect(combatCount).toBeGreaterThanOrEqual(3);
      expect(result.safety.overall).not.toBe("unsafe");
    },
  );

  it(
    "tech goal races to the target without stripping the economy",
    { timeout: 60_000 },
    async () => {
      const result = await optimize(
        request({
          objective: {
            id: "tech-rush-target",
            atSec: 360,
            targetName: "Stargate",
          },
          threats: pvzAtPriors(),
          budget: { maxGenerations: 40, maxMillis: 30_000 },
          horizonSec: 420,
        }),
      );
      const stargate = result.sim.completionTimes.Stargate ?? [];
      expect(stargate.length).toBeGreaterThan(0);
      expect(stargate[0]).toBeLessThan(280);
      // shortcuts, not all-ins: workers keep flowing
      expect(result.sim.finalWorkers).toBeGreaterThanOrEqual(25);
      expect(result.safety.overall).not.toBe("unsafe");
    },
  );
});

describe("optimizer smoke", () => {
  it(
    "unscouted baseline (all matchup threats at priors) still builds defense",
    { timeout: 60_000 },
    async () => {
      const pvz = catalog.filter(
        (t) => t.attackerRace === "Zerg" && t.vsDefender.includes("Protoss"),
      );
      const result = await optimize(
        request({
          threats: pvz.map((threat) => ({
            threat,
            probability: threat.priorProbability,
          })),
          budget: { maxGenerations: 25, maxMillis: 30_000 },
          horizonSec: 420,
        }),
      );
      // The reported degenerate output had zero combat capability
      // until 5:56. With baseline threats the build must produce
      // SOMETHING that fights before the early waves land.
      const combatNames = Object.entries(result.sim.completionTimes)
        .filter(([name]) => {
          const def = resolveProfile("5.0.16").units[name];
          return def?.combat && !def.isWorker &&
            ((def.combat.dpsGround ?? 0) > 0 || (def.combat.dpsAir ?? 0) > 0);
        })
        .flatMap(([, times]) => times);
      expect(combatNames.length).toBeGreaterThan(0);
      expect(Math.min(...combatNames)).toBeLessThan(220);
      expect(result.safety.overall).not.toBe("unsafe");
    },
  );

  it(
    "converges on a safe expansion build vs 8-pool and reports honestly",
    { timeout: 60_000 },
    async () => {
      const progressLog: OptimizeProgress[] = [];
      const result = await optimize(request(), {
        onProgress: (p) => progressLog.push(p),
      });

      // progress is monotonic non-decreasing in best score
      expect(progressLog.length).toBeGreaterThan(0);
      for (let i = 1; i < progressLog.length; i += 1) {
        expect(progressLog[i].bestScore).toBeGreaterThanOrEqual(
          progressLog[i - 1].bestScore,
        );
      }

      // the best build holds the 8-pool…
      expect(result.safety.overall).not.toBe("unsafe");
      // …and actually expands (the objective)
      const expansion = result.sim.completionTimes.Nexus ?? [];
      expect(expansion.length).toBeGreaterThan(0);
      // executes cleanly
      expect(result.sim.unexecutedActions).toBe(0);

      // fitness honesty: re-evaluating the winning actions reproduces
      // the exact reported score (deterministic sim, no stale data)
      const profile = resolveProfile(result.profileId);
      const recheck = evaluateCandidate(
        result.actions,
        profile,
        request(),
      );
      expect(Math.round(recheck.score * 100) / 100).toBe(result.score);
    },
  );

  it(
    "same seed reproduces the same result; different seed may differ",
    { timeout: 60_000 },
    async () => {
      const a = await optimize(request({ budget: { maxGenerations: 6, maxMillis: 30_000 } }));
      const b = await optimize(request({ budget: { maxGenerations: 6, maxMillis: 30_000 } }));
      expect(JSON.stringify(a.actions)).toBe(JSON.stringify(b.actions));
      expect(a.score).toBe(b.score);
    },
  );

  it(
    "cancellation returns the best-so-far within one generation",
    { timeout: 60_000 },
    async () => {
      let generationsSeen = 0;
      const result = await optimize(
        request({ budget: { maxGenerations: 200, maxMillis: 60_000 } }),
        {
          onProgress: () => {
            generationsSeen += 1;
          },
          shouldCancel: () => generationsSeen >= 3,
        },
      );
      expect(result.generations).toBeLessThanOrEqual(4);
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.sim.steps.length).toBeGreaterThan(0);
    },
  );
});
