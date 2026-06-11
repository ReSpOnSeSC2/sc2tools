import { describe, expect, it } from "vitest";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import {
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
  stepsForMatchup,
} from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { SimRace } from "../types";

/**
 * The /definitions catalog and the adaptable reference openers must
 * stay in sync: every detection rule that describes an OPENER has a
 * reference build covering it (directly or via definitionIds), so the
 * "standard openers" list always offers an adapted version of every
 * build the analyzer can detect. Pure compositions, fallback labels,
 * and the too-short markers are not openers and are excluded below.
 */
const NON_OPENER_DEFINITIONS = new Set([
  // mid/late-game compositions and transitions — no opening to adapt
  "protoss-chargelot-archon-comp",
  "protoss-robo-comp",
  "protoss-skytoss-transition",
  "terran-bio-comp",
  "terran-mech-comp",
  "terran-skyterran",
  "zerg-muta-ling-bane-comp",
  // fallback / unclassified labels
  "protoss-standard-play-unclassified",
  "terran-standard-play-unclassified",
  "zerg-standard-play-unclassified",
  "pvp-macro-transition-unclassified",
  "pvt-macro-transition-unclassified",
  "pvz-macro-transition-unclassified",
  // game-length markers
  "pvp-game-too-short",
  "pvt-game-too-short",
  "pvz-game-too-short",
  "tvp-game-too-short",
  "tvt-game-too-short",
  "tvz-game-too-short",
  "zvp-game-too-short",
  "zvt-game-too-short",
  "zvz-game-too-short",
]);

const target = resolveProfile("5.0.16");

describe("definitions catalog coverage", () => {
  const builds = referenceBuilds();
  const coveredIds = new Set(builds.flatMap((b) => b.definitionIds ?? []));
  const catalogIds = new Set(BUILD_DEFINITIONS.map((d) => d.id));

  it("every opener definition has an adaptable reference build", () => {
    const uncovered = BUILD_DEFINITIONS.filter(
      (d) => !NON_OPENER_DEFINITIONS.has(d.id) && !coveredIds.has(d.id),
    ).map((d) => d.id);
    expect(uncovered).toEqual([]);
  });

  it("every referenced definition id exists in the catalog", () => {
    const unknown = [...coveredIds].filter((id) => !catalogIds.has(id));
    expect(unknown).toEqual([]);
  });

  it("non-opener exclusions stay in the catalog (denylist hygiene)", () => {
    for (const id of NON_OPENER_DEFINITIONS) {
      expect(catalogIds.has(id), `${id} no longer exists`).toBe(true);
    }
  });
});

describe("protoss gas timing convention", () => {
  it("second assimilator waits for the cybernetics core outside PvP", () => {
    // PTR meta guidance: standard protoss is gas -> core -> second
    // gas; double gas before core is a PvP-specific pattern.
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      if (build.matchups.length === 1 && build.matchups[0] === "PvP") continue;
      const gasIndices = build.steps
        .map((s, i) => (s === "Assimilator" ? i : -1))
        .filter((i) => i >= 0);
      if (gasIndices.length < 2) continue;
      const coreIndex = build.steps.indexOf("CyberneticsCore");
      if (coreIndex < 0) continue;
      expect(
        gasIndices[1],
        `${build.id}: second assimilator before the core`,
      ).toBeGreaterThan(coreIndex);
    }
  });
});

describe("PvT first-defense rule (user's PTR guidance)", () => {
  // "For PvT we need a unit out as close to 2:42 as possible — 2:47
  // is fine." Proxied rushes are exempt (their units pop at the proxy
  // on their own schedule); the cannon rush counts its first cannon.
  const FIRST_DEFENSE_DEADLINE_SEC = 167; // 2:47
  const RUSH_EXEMPT = new Set(["p-proxy-4gate"]);

  function firstDefenseAt(buildId: string): { at: number; name: string } {
    const build = referenceBuilds().find((b) => b.id === buildId)!;
    const { actions } = actionsFromSteps(
      target,
      stepsForMatchup(build, "PvT"),
    );
    const sim = adaptBuild({
      baselineProfileId: build.native ?? "lotv-base",
      profileId: "5.0.16",
      race: "Protoss",
      actions,
      referenceName: build.name,
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 600,
    }).sim;
    let first = Infinity;
    let firstName = "";
    for (const [name, times] of Object.entries(sim.completionTimes)) {
      const def = target.units[name];
      const fights =
        def?.combat &&
        !def.isWorker &&
        ((def.combat.dpsGround ?? 0) > 0 || (def.combat.dpsAir ?? 0) > 0);
      if (fights && times[0] < first) {
        first = times[0];
        firstName = name;
      }
    }
    return { at: first, name: firstName };
  }

  it("every standard PvT protoss opener fields defense by 2:47", () => {
    const pvtBuilds = referenceBuilds().filter(
      (b) =>
        b.race === "Protoss" &&
        b.matchups.includes("PvT") &&
        !RUSH_EXEMPT.has(b.id),
    );
    expect(pvtBuilds.length).toBeGreaterThan(10);
    // Standard play never opens zealot; the scouted proxy-reaper
    // response is the lone exception (zealot beats the 2:15 reaper).
    for (const build of pvtBuilds) {
      const first = firstDefenseAt(build.id);
      expect(
        first.at,
        `${build.id} first defense too late`,
      ).toBeLessThanOrEqual(FIRST_DEFENSE_DEADLINE_SEC);
      if (build.id !== "p-proxy-reaper-response") {
        expect(
          first.name,
          `${build.id} opens with a zealot`,
        ).not.toBe("Zealot");
      }
    }
  });

  it("the proxy reaper response zealot beats the ~2:15 reaper", () => {
    const first = firstDefenseAt("p-proxy-reaper-response");
    expect(first.name).toBe("Zealot");
    expect(first.at).toBeLessThanOrEqual(135);
    // core first, then zealot, nexus delayed — and the second gas is
    // pushed back to pay for the zealot (after the nexus in the list)
    const build = referenceBuilds().find(
      (b) => b.id === "p-proxy-reaper-response",
    )!;
    const steps = build.steps;
    expect(steps.indexOf("CyberneticsCore")).toBeLessThan(
      steps.indexOf("Zealot"),
    );
    expect(steps.indexOf("Zealot")).toBeLessThan(steps.indexOf("Nexus"));
    const secondGas = steps.indexOf(
      "Assimilator",
      steps.indexOf("Assimilator") + 1,
    );
    expect(secondGas).toBeGreaterThan(steps.indexOf("Nexus"));
  });

  it("PvT variants go core before nexus; base steps stay nexus-first", () => {
    const gateExpand = referenceBuilds().find(
      (b) => b.id === "p-gate-expand",
    )!;
    const pvt = stepsForMatchup(gateExpand, "PvT");
    expect(pvt.indexOf("CyberneticsCore")).toBeLessThan(pvt.indexOf("Nexus"));
    const pvz = stepsForMatchup(gateExpand, "PvZ");
    expect(pvz.indexOf("Nexus")).toBeLessThan(pvz.indexOf("CyberneticsCore"));
  });
});

describe("5.0.16 warpgate meta (user's PTR guidance)", () => {
  // "You cannot start warpgate until you get your second gateway up"
  // — the research occupies a gateway, so every gateway listed before
  // it must be standing when it starts. The PvP proxy warpgate rush
  // researches off its lone first gateway on purpose and is covered
  // by the same rule (one listed gateway → no extra wait).

  function simSteps(steps: string[]) {
    const { actions } = actionsFromSteps(target, steps);
    return simulate(actions, target, "Protoss", {
      horizonSec: 600,
      policies: defaultPolicies(),
    });
  }

  it("research never starts before the gateways listed ahead of it", () => {
    const seen = new Set<string>();
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      for (const matchup of build.matchups) {
        const steps = stepsForMatchup(build, matchup);
        const key = steps.join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const wgrIndex = steps.indexOf("WarpGateResearch");
        if (wgrIndex < 0) continue;
        const prior = steps
          .slice(0, wgrIndex)
          .filter((s) => s === "Gateway").length;
        const sim = simSteps(steps);
        const research = sim.steps.find(
          (s) => s.name === "WarpGateResearch",
        )!;
        const gateDone = sim.steps
          .filter((s) => s.name === "Gateway")
          .map((s) => s.doneSec)
          .sort((a, b) => a - b);
        expect(
          research.startSec,
          `${build.id} (${matchup}): warpgate before gateway #${prior} finished`,
        ).toBeGreaterThanOrEqual(gateDone[prior - 1] - 0.01);
      }
    }
  });

  it("the proxy warpgate rush still researches off one gateway", () => {
    const rush = referenceBuilds().find(
      (b) => b.id === "p-proxy-warpgate-rush",
    )!;
    const sim = simSteps(rush.steps);
    const research = sim.steps.find((s) => s.name === "WarpGateResearch")!;
    const gateDone = sim.steps
      .filter((s) => s.name === "Gateway")
      .map((s) => s.doneSec)
      .sort((a, b) => a - b);
    expect(research.startSec).toBeLessThan(gateDone[1]);
  });

  it("the 12-worker baseline keeps researching at the core, ungated", () => {
    // Old patch: warpgate lives at the cybernetics core and occupies
    // no gateway, so the meta gate must not delay the baseline sim.
    const build = referenceBuilds().find((b) => b.id === "p-gate-expand")!;
    const baseline = resolveProfile(build.native ?? "lotv-base");
    const { actions } = actionsFromSteps(target, build.steps);
    const sim = simulate(actions, baseline, "Protoss", {
      horizonSec: 600,
      policies: defaultPolicies(),
    });
    const research = sim.steps.find((s) => s.name === "WarpGateResearch")!;
    const gateDone = sim.steps
      .filter((s) => s.name === "Gateway")
      .map((s) => s.doneSec)
      .sort((a, b) => a - b);
    expect(research.startSec).toBeLessThan(gateDone[1]);
  });
});

describe("stargate openers favor adepts (user's PTR guidance)", () => {
  // "You keep building adepts for most stargate builds — they're
  // lower gas and the phoenixes are your anti-air." The gas stays in
  // the stargate; gateway minerals buy 25-gas adepts. Exceptions:
  // Stargate into Blink (blink stalkers ARE the plan) and the PvP
  // 4 Stalker Oracle.
  const STALKER_EXCEPTIONS = new Set([
    "p-stargate-blink",
    "p-4stalker-oracle",
  ]);

  it("gateway production behind a stargate is adept-heavy", () => {
    let checked = 0;
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      if (STALKER_EXCEPTIONS.has(build.id)) continue;
      const lists = [
        build.steps,
        ...Object.values(build.stepsByMatchup ?? {}),
      ];
      for (const steps of lists) {
        if (!steps.includes("Stargate")) continue;
        checked += 1;
        const adepts = steps.filter((s) => s === "Adept").length;
        const stalkers = steps.filter((s) => s === "Stalker").length;
        expect(
          adepts,
          `${build.id}: stalkers should not crowd out adepts`,
        ).toBeGreaterThan(stalkers);
      }
    }
    expect(checked).toBeGreaterThan(8);
  });
});

describe("PvT shield battery coverage (user's PTR guidance)", () => {
  // "Not every standard build, but 80-90% get a safety battery."
  // All-ins, proxies and rushes spend every mineral on the punch.
  const NO_BATTERY_ARCHETYPES = new Set([
    "p-4gate",
    "p-proxy-4gate",
    "p-blink-allin",
    "p-7gate-blink",
    "p-cannon-rush",
    "p-chargelot-allin",
    "p-dt-rush",
    "p-proxy-stargate",
  ]);

  it("80-90% of standard PvT openers include a shield battery", () => {
    const standard = referenceBuilds().filter(
      (b) =>
        b.race === "Protoss" &&
        b.matchups.includes("PvT") &&
        !NO_BATTERY_ARCHETYPES.has(b.id),
    );
    expect(standard.length).toBeGreaterThan(10);
    const withBattery = standard.filter((b) =>
      stepsForMatchup(b, "PvT").includes("ShieldBattery"),
    );
    const fraction = withBattery.length / standard.length;
    expect(fraction).toBeGreaterThanOrEqual(0.8);
    // "not every" — a couple of openers legitimately skip it
    expect(withBattery.length).toBeLessThan(standard.length);
  });
});

describe("every reference build adapts cleanly to 5.0.16", () => {
  for (const build of referenceBuilds()) {
    it(`${build.id} resolves and simulates with no dead steps`, () => {
      const { actions, unknownNames } = actionsFromSteps(target, build.steps);
      expect(unknownNames).toEqual([]);
      expect(actions.length).toBeGreaterThan(5);
      const result = adaptBuild({
        baselineProfileId: build.native ?? "lotv-base",
        profileId: "5.0.16",
        race: build.race as SimRace,
        actions,
        referenceName: build.name,
        referenceId: build.id,
        threats: [],
        policies: defaultPolicies(),
        safety: { hasWall: true, allowWorkerPull: true },
        horizonSec: 600,
      });
      expect(result.sim.unexecutedActions, build.id).toBe(0);
      expect(result.baselineSim.unexecutedActions, `${build.id} baseline`).toBe(
        0,
      );
    });
  }
});

describe("replay-calibrated builds (ReSpOnSe ladder replays, 2026-03..05, patch 5.0.15)", () => {
  // Calibration source: 679 ladder replays parsed through the production
  // replay engine (scripts/calibration/parse_calibration_replays.py —
  // parse_deep → extract_events → UserBuildDetector, frame/22.4 timebase).
  // Every number below is the MEDIAN over that build's games on the
  // 12-worker patch 5.0.15. The lotv-base sim is an idealized player: it
  // may land a little EARLY against the medians but never meaningfully
  // LATE — and not absurdly early either, or the model has drifted.
  const LATE_SLACK_SEC = 20;
  const EARLY_SLACK_SEC = 75;
  const baseline = resolveProfile("lotv-base");

  function calibSim(steps: string[]) {
    const { actions, unknownNames } = actionsFromSteps(baseline, steps);
    expect(unknownNames).toEqual([]);
    return simulate(actions, baseline, "Protoss", {
      horizonSec: 600,
      policies: defaultPolicies(),
    });
  }

  function nthStart(
    sim: ReturnType<typeof simulate>,
    name: string,
    nth: number,
  ): number {
    const starts = sim.steps
      .filter((s) => s.name === name)
      .map((s) => s.startSec);
    expect(starts.length, `${name} #${nth + 1} missing`).toBeGreaterThan(nth);
    return starts[nth];
  }

  interface ReplayCalibration {
    id: string;
    matchup: string;
    /**
     * Calibrate against the base step list instead of the matchup
     * variant. The replays were played nexus-first on 5.0.15 (the base
     * shape); PvT variants are the deliberate core-first 5.0.16
     * adjustment and are covered by the first-defense rule above.
     */
    useBaseSteps?: boolean;
    /** filename, date, opponent of a representative recent win. */
    cite: string;
    games: string;
    /** [structure name, nth occurrence, median start sec] */
    starts: [string, number, number][];
    /** [unit/upgrade name, median first-completion sec] */
    done: [string, number][];
    /** expected first chrono targets, in cast order */
    chronos: string[];
  }

  const CALIBRATIONS: ReplayCalibration[] = [
    {
      // White Rabbit LE (181).SC2Replay, 2026-05-25 win vs PovertyTech (T)
      id: "p-phoenix-robo",
      matchup: "PvT",
      useBaseSteps: true,
      cite: "White Rabbit LE (181), 2026-05-25 vs PovertyTech",
      games: "117 games, 72 wins",
      starts: [
        ["Gateway", 0, 38], ["Nexus", 0, 83], ["CyberneticsCore", 0, 93],
        ["ShieldBattery", 0, 134], ["Stargate", 0, 147], ["Gateway", 1, 224],
        ["RoboticsFacility", 0, 238], ["RoboticsBay", 0, 301], ["Nexus", 1, 319],
      ],
      done: [
        ["Stalker", 149], ["Adept", 182], ["Sentry", 206],
        ["Phoenix", 210], ["Immortal", 326],
      ],
      chronos: ["Nexus", "Gateway", "Nexus", "Stargate", "RoboticsFacility"],
    },
    {
      // White Rabbit LE (159).SC2Replay, 2026-05-02 win vs NoCannonRush (P)
      // Strange's 1 Gate Expand: sentry-first, gateways #2/#3 by ~2:40,
      // triple core chrono on the warpgate research.
      id: "p-gate-expand",
      matchup: "PvP",
      cite: "White Rabbit LE (159), 2026-05-02 vs NoCannonRush",
      games: "49 games, 37 wins (+23 standard 1-gate-expand games)",
      starts: [
        ["Nexus", 0, 82], ["CyberneticsCore", 0, 92], ["Gateway", 1, 145],
        ["Gateway", 2, 157], ["RoboticsFacility", 0, 242],
      ],
      done: [["Sentry", 159], ["Stalker", 215], ["WarpGateResearch", 201]],
      chronos: ["Nexus", "CyberneticsCore", "CyberneticsCore", "CyberneticsCore", "Nexus"],
    },
    {
      // White Rabbit LE (180).SC2Replay, 2026-05-24 win vs lOKY (Z)
      id: "p-carrier-rush",
      matchup: "PvZ",
      cite: "White Rabbit LE (180), 2026-05-24 vs lOKY",
      games: "47 games, 35 wins",
      starts: [
        ["Stargate", 0, 146], ["Nexus", 1, 228], ["FleetBeacon", 0, 279],
        ["Stargate", 1, 294], ["Forge", 0, 301],
      ],
      done: [["Adept", 154], ["Oracle", 230]],
      chronos: ["Nexus", "Gateway", "Gateway", "Nexus", "Stargate", "Stargate"],
    },
    {
      // Taito Citadel LE (190).SC2Replay, 2026-05-25 win vs IIIIIIIIIIII (Z)
      id: "p-dt-rush",
      matchup: "PvZ",
      cite: "Taito Citadel LE (190), 2026-05-25 vs IIIIIIIIIIII",
      games: "39 games, 32 wins",
      starts: [
        ["TwilightCouncil", 0, 152], ["DarkShrine", 0, 210], ["Forge", 0, 243],
        ["Stargate", 0, 244], ["Stargate", 1, 255], ["Nexus", 1, 295],
      ],
      done: [["DarkTemplar", 292], ["VoidRay", 343]],
      chronos: ["Nexus", "Gateway", "Nexus", "Nexus", "Stargate", "Stargate"],
    },
    {
      // Taito Citadel LE (172).SC2Replay, 2026-05-10 win vs WatchOut (P)
      id: "p-4stalker-oracle",
      matchup: "PvP",
      cite: "Taito Citadel LE (172), 2026-05-10 vs WatchOut",
      games: "29 games, 21 wins",
      starts: [
        ["Assimilator", 1, 55], ["Gateway", 1, 68], ["CyberneticsCore", 0, 87],
        ["Stargate", 0, 141], ["Nexus", 0, 213], ["RoboticsFacility", 0, 251],
      ],
      done: [
        ["Adept", 154], ["Oracle", 216], ["Stalker", 241],
        ["WarpGateResearch", 225], ["Immortal", 340],
      ],
      chronos: ["Nexus", "Nexus", "Stargate", "Stargate"],
    },
    {
      // Taito Citadel LE (189).SC2Replay, 2026-05-25 win vs Koht (Z)
      id: "p-stargate-robo",
      matchup: "PvZ",
      cite: "Taito Citadel LE (189), 2026-05-25 vs Koht",
      games: "28 games, 16 wins",
      starts: [
        ["Stargate", 0, 146], ["Gateway", 1, 200], ["Nexus", 1, 231],
        ["RoboticsFacility", 0, 253], ["TwilightCouncil", 0, 258],
      ],
      done: [["Adept", 156], ["VoidRay", 226]],
      chronos: ["Nexus", "Gateway", "Gateway", "Nexus", "Stargate", "Stargate"],
    },
    {
      // Old Republic LE (246).SC2Replay, 2026-05-26 win vs Bingbangboom (Z)
      id: "p-stargate-glaives",
      matchup: "PvZ",
      cite: "Old Republic LE (246), 2026-05-26 vs Bingbangboom",
      games: "26 games, 17 wins",
      starts: [
        ["Stargate", 0, 145], ["Nexus", 1, 228], ["TwilightCouncil", 0, 251],
        ["Gateway", 2, 265], ["Gateway", 3, 271],
      ],
      done: [["Adept", 152], ["VoidRay", 231]],
      chronos: ["Nexus", "Gateway", "Gateway", "Nexus", "Stargate", "Stargate"],
    },
    {
      // Ruby Rock LE (234).SC2Replay, 2026-05-25 win vs PovertyTech (T)
      id: "p-robo-expand",
      matchup: "PvT",
      useBaseSteps: true,
      cite: "Ruby Rock LE (234), 2026-05-25 vs PovertyTech",
      games: "25 games, 17 wins",
      starts: [
        ["Nexus", 0, 83], ["ShieldBattery", 0, 134], ["RoboticsFacility", 0, 173],
        ["Gateway", 1, 208], ["RoboticsBay", 0, 234], ["Nexus", 1, 251],
        ["Forge", 0, 285],
      ],
      done: [
        ["Stalker", 148], ["Sentry", 171], ["Observer", 240],
        ["Immortal", 282], ["Colossus", 342],
      ],
      chronos: ["Nexus", "Gateway", "Nexus", "RoboticsFacility"],
    },
    {
      // Taito Citadel LE (188).SC2Replay, 2026-05-25 win vs Thenix (P)
      id: "p-2gate-expand",
      matchup: "PvP",
      cite: "Taito Citadel LE (188), 2026-05-25 vs Thenix",
      games: "25 games, 14 wins",
      starts: [
        ["Assimilator", 1, 56], ["Gateway", 1, 68], ["CyberneticsCore", 0, 86],
        ["Nexus", 0, 165], ["RoboticsFacility", 0, 205],
      ],
      done: [["Sentry", 147], ["Stalker", 172], ["WarpGateResearch", 223]],
      chronos: ["Nexus", "Nexus", "CyberneticsCore"],
    },
    {
      // Tourmaline LE (225).SC2Replay, 2026-05-14 win vs Koht (Z)
      id: "p-glaive-adept",
      matchup: "PvZ",
      cite: "Tourmaline LE (225), 2026-05-14 vs Koht",
      games: "17 games, 10 wins",
      starts: [
        ["TwilightCouncil", 0, 157], ["Gateway", 1, 165], ["Nexus", 1, 289],
      ],
      done: [
        ["Stalker", 149], ["Sentry", 191], ["Adept", 244],
        ["ResonatingGlaives", 307],
      ],
      chronos: ["Nexus", "Gateway", "Nexus", "TwilightCouncil", "TwilightCouncil"],
    },
  ];

  for (const calib of CALIBRATIONS) {
    const build = referenceBuilds().find((b) => b.id === calib.id)!;
    const steps = calib.useBaseSteps
      ? build.steps
      : stepsForMatchup(build, calib.matchup);

    it(`${calib.id} (${calib.matchup}) baseline sim lands inside the replay window — ${calib.games}; e.g. ${calib.cite}`, () => {
      const sim = calibSim(steps);
      expect(sim.unexecutedActions, calib.id).toBe(0);
      for (const [name, nth, medianSec] of calib.starts) {
        const at = nthStart(sim, name, nth);
        expect(
          at,
          `${calib.id}: ${name} #${nth + 1} later than replays (${at} > ${medianSec})`,
        ).toBeLessThanOrEqual(medianSec + LATE_SLACK_SEC);
        expect(
          at,
          `${calib.id}: ${name} #${nth + 1} unrealistically early (${at} << ${medianSec})`,
        ).toBeGreaterThanOrEqual(medianSec - EARLY_SLACK_SEC);
      }
      for (const [name, medianSec] of calib.done) {
        const at = sim.completionTimes[name]?.[0];
        expect(at, `${calib.id}: ${name} never completed`).toBeDefined();
        expect(
          at!,
          `${calib.id}: first ${name} later than replays`,
        ).toBeLessThanOrEqual(medianSec + LATE_SLACK_SEC);
        expect(
          at!,
          `${calib.id}: first ${name} unrealistically early`,
        ).toBeGreaterThanOrEqual(medianSec - EARLY_SLACK_SEC);
      }
    });

    it(`${calib.id} (${calib.matchup}) casts the replay chrono pattern`, () => {
      const sim = calibSim(steps);
      const casts = sim.events
        .filter((e) => e.kind === "chrono")
        .map((e) => e.name);
      expect(
        casts.slice(0, calib.chronos.length),
        `${calib.id}: chrono targets diverge from replays`,
      ).toEqual(calib.chronos);
    });
  }

  it("replay ordering facts hold in the calibrated step lists", () => {
    const get = (id: string) => referenceBuilds().find((b) => b.id === id)!;
    const idxOf = (steps: string[], name: string, nth = 0) => {
      let seen = -1;
      for (let i = 0; i < steps.length; i += 1) {
        if (steps[i] === name) {
          seen += 1;
          if (seen === nth) return i;
        }
      }
      return -1;
    };

    // Phoenix into Robo: stalker is the first army unit (115/117 games),
    // battery right behind it, robo AFTER the second gateway, robo bay in
    // the opening, third nexus in the list. PvT variant keeps core-first.
    const phoenix = get("p-phoenix-robo");
    const pSteps = phoenix.steps;
    const firstArmy = pSteps.find((s) =>
      ["Stalker", "Adept", "Zealot", "Sentry"].includes(s),
    );
    expect(firstArmy).toBe("Stalker");
    expect(idxOf(pSteps, "ShieldBattery")).toBeGreaterThan(
      idxOf(pSteps, "Stalker"),
    );
    expect(idxOf(pSteps, "RoboticsFacility")).toBeGreaterThan(
      idxOf(pSteps, "Gateway", 1),
    );
    expect(pSteps).toContain("RoboticsBay");
    const pvt = stepsForMatchup(phoenix, "PvT");
    expect(idxOf(pvt, "CyberneticsCore")).toBeLessThan(idxOf(pvt, "Nexus"));

    // Strange's 1 Gate Expand (PvP): sentry first (the detector's
    // signature), three gateways, robo follow-up.
    const strange = stepsForMatchup(get("p-gate-expand"), "PvP");
    const sFirst = strange.find((s) =>
      ["Stalker", "Adept", "Zealot", "Sentry"].includes(s),
    );
    expect(sFirst).toBe("Sentry");
    const strangeRobo = idxOf(strange, "RoboticsFacility");
    expect(
      strange.filter((s, i) => s === "Gateway" && i < strangeRobo),
    ).toHaveLength(3);

    // Carrier Rush: oracle (not void ray) from stargate #1, third nexus
    // BEFORE the fleet beacon, second stargate behind it (42/47 games).
    const carrier = get("p-carrier-rush").steps;
    expect(idxOf(carrier, "Oracle")).toBeGreaterThan(-1);
    expect(carrier).not.toContain("VoidRay");
    expect(idxOf(carrier, "Nexus", 1)).toBeLessThan(
      idxOf(carrier, "FleetBeacon"),
    );
    expect(carrier.filter((s) => s === "Stargate")).toHaveLength(2);

    // DT Opener (PvZ): expand first, twilight before gateway #2, shrine
    // before BOTH stargates (35/39 games add stargates behind the DTs).
    const dt = stepsForMatchup(get("p-dt-rush"), "PvZ");
    expect(idxOf(dt, "Nexus")).toBeLessThan(idxOf(dt, "TwilightCouncil"));
    expect(idxOf(dt, "TwilightCouncil")).toBeLessThan(idxOf(dt, "Gateway", 1));
    expect(idxOf(dt, "DarkShrine")).toBeLessThan(idxOf(dt, "Stargate", 0));
    expect(dt.filter((s) => s === "Stargate")).toHaveLength(2);

    // AlphaStar oracle (PvP): both gases before gateway #2, gateway #2
    // before the core, stargate before the (delayed ~3:33) nexus.
    const alpha = get("p-4stalker-oracle").steps;
    expect(idxOf(alpha, "Assimilator", 1)).toBeLessThan(
      idxOf(alpha, "Gateway", 1),
    );
    expect(idxOf(alpha, "Gateway", 1)).toBeLessThan(
      idxOf(alpha, "CyberneticsCore"),
    );
    expect(idxOf(alpha, "Stargate")).toBeLessThan(idxOf(alpha, "Nexus"));

    // Stargate into Robo / into Glaives (PvZ): stargate is the first
    // tech, fast third nexus, twilight behind it.
    for (const [id, mu] of [
      ["p-stargate-robo", "PvZ"],
      ["p-stargate-glaives", "PvZ"],
    ] as const) {
      const sg = stepsForMatchup(get(id), mu);
      expect(idxOf(sg, "Stargate")).toBeLessThan(idxOf(sg, "TwilightCouncil"));
      expect(sg.filter((s) => s === "Nexus")).toHaveLength(2);
    }

    // Robo First (PvT): robo BEFORE gateway #2 (25/25 games), robo bay
    // into colossus, battery in the opening.
    const robo = get("p-robo-expand").steps;
    expect(idxOf(robo, "RoboticsFacility")).toBeLessThan(
      idxOf(robo, "Gateway", 1),
    );
    expect(robo).toContain("RoboticsBay");
    expect(robo).toContain("Colossus");
    expect(robo).toContain("ShieldBattery");

    // 2 Gate Expand (PvP): double gas before gateway #2, sentry first,
    // nexus after the core (~2:45), robo follow-up.
    const twoGate = stepsForMatchup(get("p-2gate-expand"), "PvP");
    expect(idxOf(twoGate, "Assimilator", 1)).toBeLessThan(
      idxOf(twoGate, "Gateway", 1),
    );
    const tFirst = twoGate.find((s) =>
      ["Stalker", "Adept", "Zealot", "Sentry"].includes(s),
    );
    expect(tFirst).toBe("Sentry");
    expect(idxOf(twoGate, "CyberneticsCore")).toBeLessThan(
      idxOf(twoGate, "Nexus"),
    );

    // Adept Glaives No Robo (PvZ): twilight before gateway #2, glaives
    // researched, and — per the build's name — no robotics facility.
    const glaive = stepsForMatchup(get("p-glaive-adept"), "PvZ");
    expect(idxOf(glaive, "TwilightCouncil")).toBeLessThan(
      idxOf(glaive, "Gateway", 1),
    );
    expect(glaive).toContain("ResonatingGlaives");
    expect(glaive).not.toContain("RoboticsFacility");
  });

  it("chrono tokens actually move boosted timings (and autoChrono stays off)", () => {
    expect(defaultPolicies().autoChrono).toBe("off");
    // Carrier rush: stargate chronos pull the first oracle forward.
    const carrier = referenceBuilds().find((b) => b.id === "p-carrier-rush")!;
    const stripped = carrier.steps.filter(
      (s) => !s.toLowerCase().startsWith("chrono:"),
    );
    const withChrono = calibSim(carrier.steps);
    const withoutChrono = calibSim(stripped);
    const boosted = withChrono.completionTimes.Oracle?.[0];
    const unboosted = withoutChrono.completionTimes.Oracle?.[0];
    expect(boosted).toBeDefined();
    expect(unboosted).toBeDefined();
    expect(boosted!).toBeLessThan(unboosted!);
    // Phoenix into Robo: gateway + stargate chronos land the first
    // phoenix earlier than the unboosted line.
    const phoenix = referenceBuilds().find((b) => b.id === "p-phoenix-robo")!;
    const pBoosted = calibSim(phoenix.steps).completionTimes.Phoenix?.[0];
    const pUnboosted = calibSim(
      phoenix.steps.filter((s) => !s.toLowerCase().startsWith("chrono:")),
    ).completionTimes.Phoenix?.[0];
    expect(pBoosted!).toBeLessThan(pUnboosted!);
  });
});
