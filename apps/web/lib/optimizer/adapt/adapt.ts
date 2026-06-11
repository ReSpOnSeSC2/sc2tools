/**
 * Build adaptation: take a known 12-worker build order (a shipped
 * reference opener or one of the user's saved custom builds), keep
 * the same buildings in the same order, and re-time it under a
 * different patch profile — "get to the same positions with the same
 * buildings", with the simulator computing when those positions are
 * actually reachable on the new economy.
 *
 * Worker production, supply, and gas saturation are macro policies
 * the simulator re-derives per patch, so a 12-worker build's "14
 * Pylon" naturally becomes whatever the 8-worker economy supports.
 */
import {
  rulesToSignature,
  type BuildRuleLike,
  type BuildSignatureItem,
} from "@/lib/build-events";
import protossReferences from "../data/reference-builds/protoss.json";
import terranReferences from "../data/reference-builds/terran.json";
import zergReferences from "../data/reference-builds/zerg.json";
import { resolveProfile } from "../patch/profiles";
import { evaluateSafety } from "../safety/evaluate";
import { simulate } from "../sim/engine";
import type {
  AdaptRequest,
  AdaptResult,
  BuildAction,
  ComparisonRow,
  PatchProfile,
  ReferenceBuild,
  SimRace,
  SimResult,
} from "../types";

export function referenceBuilds(): ReferenceBuild[] {
  return [
    ...(protossReferences.builds as ReferenceBuild[]),
    ...(terranReferences.builds as ReferenceBuild[]),
    ...(zergReferences.builds as ReferenceBuild[]),
  ].map((b) => ({ ...b }));
}

export function referenceBuildsForRace(race: SimRace): ReferenceBuild[] {
  return referenceBuilds().filter((b) => b.race === race);
}

/**
 * Names the policies own — never part of an adapted action list.
 * Only workers: supply structures are real build-order steps (a
 * gateway needs its pylon) and get re-timed like everything else;
 * auto-supply just covers any gaps the reference leaves later on.
 */
function isPolicyOwned(profile: PatchProfile, name: string): boolean {
  return Boolean(profile.units[name]?.isWorker);
}

/**
 * Legacy names that appear in saved build signatures/rules but aren't
 * profile entries. Warpgates especially: replay trackers record
 * transformed gateways (and units warped from them) as "WarpGate".
 */
const NAME_ALIASES: Record<string, string> = {
  warpgate: "Gateway",
  templararchive: "TemplarArchives",
  psistormtech: "PsiStorm",
  psionicstorm: "PsiStorm",
  lurkerdenmp: "LurkerDen",
  lurkermp: "Lurker",
  swarmhostmp: "SwarmHost",
  broodlord: "BroodLord",
  blink: "BlinkTech",
};

/** Case-insensitive canonical-name index over units + upgrades. */
function nameIndex(profile: PatchProfile): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of Object.keys(profile.units)) {
    index.set(name.toLowerCase(), name);
  }
  for (const name of Object.keys(profile.upgrades)) {
    index.set(name.toLowerCase(), name);
  }
  for (const [alias, canonical] of Object.entries(NAME_ALIASES)) {
    if (!index.has(alias) && index.has(canonical.toLowerCase())) {
      index.set(alias, canonical);
    }
  }
  return index;
}

export function actionForName(
  profile: PatchProfile,
  name: string,
): BuildAction | null {
  if (profile.upgrades[name]) return { kind: "research", name };
  const def = profile.units[name];
  if (!def) return null;
  if (def.morphFrom) return { kind: "morph", name };
  if (def.isStructure) return { kind: "build", name };
  return { kind: "train", name };
}

export interface ResolvedActions {
  actions: BuildAction[];
  unknownNames: string[];
  /** True when derived from sparse v3 rules (milestones, not steps). */
  fromRules?: boolean;
  /** Latest milestone time the source carried (drives sim horizon). */
  latestMilestoneSec?: number;
}

/** Step tokens with special meaning beyond unit/upgrade names. */
const TRANSFORM_TOKENS = new Set(["transformwarpgate", "warpgatetransform"]);

/**
 * Chrono step token: `"Chrono:Stargate"` spends 50 nexus energy on the
 * named structure at this point in the order. Targets are replay-
 * calibrated (see the replay-calibrated describe in
 * catalog-coverage.test.ts) - the explicit tokens drive chrono so
 * `MacroPolicies.autoChrono` stays "off" by default.
 */
const CHRONO_PREFIX = "chrono:";

/** Reference steps (canonical names, in order) → executable actions. */
export function actionsFromSteps(
  profile: PatchProfile,
  steps: string[],
): ResolvedActions {
  const index = nameIndex(profile);
  const actions: BuildAction[] = [];
  const unknownNames: string[] = [];
  for (const raw of steps) {
    const lowered = raw.trim().toLowerCase();
    if (TRANSFORM_TOKENS.has(lowered)) {
      actions.push({ kind: "transform-warpgate", name: "Gateway" });
      continue;
    }
    if (lowered.startsWith(CHRONO_PREFIX)) {
      const target = index.get(lowered.slice(CHRONO_PREFIX.length).trim());
      if (!target) {
        unknownNames.push(raw);
        continue;
      }
      // `name` is namespaced so comparison rows and step lookups never
      // collide with the target structure's own build steps.
      actions.push({ kind: "chrono", name: `Chrono:${target}`, target });
      continue;
    }
    // v3 rules name events with the agent's verb prefixes
    // ("BuildVoidRay", "ResearchBlink") — strip and retry.
    const canonical =
      index.get(lowered) ??
      index.get(lowered.replace(/^(build|train|research|morph|upgrade)/, ""));
    if (!canonical) {
      unknownNames.push(raw);
      continue;
    }
    if (isPolicyOwned(profile, canonical)) continue;
    const action = actionForName(profile, canonical);
    if (!action) continue;
    if (canonical === "WarpGateResearch") {
      // 5.0.16 meta: the research occupies a gateway, so it must wait
      // for every gateway listed before it to finish — "you cannot
      // start warpgate until you get your second gateway up". Rush
      // builds that list only one gateway first keep researching
      // immediately; old-patch baselines ignore the gate entirely.
      const priorGateways = actions.filter(
        (a) => a.kind === "build" && a.name === "Gateway",
      ).length;
      if (priorGateways > 0) {
        action.afterCompleted = { unit: "Gateway", count: priorGateways };
      }
    }
    actions.push(action);
  }
  return { actions, unknownNames };
}

/**
 * A saved custom build's signature ([{unit, count, beforeSec}]) →
 * ordered actions. Signatures store icon-resolved lowercase names and
 * earliest-seen times; sorting by time recovers the build order.
 */
export function actionsFromSignature(
  profile: PatchProfile,
  signature: BuildSignatureItem[],
): ResolvedActions {
  const expanded: string[] = [];
  const sorted = [...signature].sort((a, b) => a.beforeSec - b.beforeSec);
  for (const item of sorted) {
    const count = Math.max(1, Math.min(20, Math.round(item.count)));
    for (let i = 0; i < count; i += 1) expanded.push(item.unit);
  }
  return actionsFromSteps(profile, expanded);
}

/**
 * Inject missing tech ancestors before their dependents. Rules-based
 * builds are sparse milestone lists ("Dark Shrine by 5:24, 3
 * Stargates by 10:00") — the chain of pylons/gateways/cybers that
 * makes them buildable is implied, so the adapter fills it in.
 */
export function injectPrerequisites(
  profile: PatchProfile,
  actions: BuildAction[],
): BuildAction[] {
  const out: BuildAction[] = [];
  const present = new Set<string>();
  // Milestone lists rarely mention gas buildings, but their tech is
  // gas-priced — without income injection the sim stalls forever at
  // the first gas cost (user's DT/3-stargate build froze at the
  // cybernetics core). One collector for light gas needs, both
  // geysers for real gas builds.
  const race = actions
    .map(
      (a) =>
        profile.units[a.name]?.race ?? profile.upgrades[a.name]?.race,
    )
    .find((r) => r !== undefined);
  const gasName = Object.entries(profile.units).find(
    ([, def]) => def.isGasBuilding && def.race === race,
  )?.[0];
  const totalGasCost = actions.reduce((sum, action) => {
    if (action.kind === "research") {
      return sum + (profile.upgrades[action.name]?.gas ?? 0);
    }
    const def = profile.units[action.name];
    const count = def?.pairTrained ? 2 : 1;
    return sum + (def?.gas ?? 0) * count;
  }, 0);
  const ensure = (name: string, depth: number) => {
    if (depth > 8 || present.has(name)) return;
    const def = profile.units[name] ?? null;
    const upgrade = profile.upgrades[name] ?? null;
    const requires = def?.requires ?? upgrade?.requires ?? [];
    const producers = (
      def
        ? def.builtFrom.filter(
            (b) => profile.units[b]?.isStructure,
          )
        : (upgrade?.researchedAt ?? [])
    ).slice(0, 1);
    if (def?.morphFrom) producers.push(def.morphFrom);
    for (const entry of [...requires, ...producers]) {
      const alternatives = entry.split("|");
      if (alternatives.some((alt) => present.has(alt))) continue;
      const ancestor = alternatives[0];
      const ancestorDef = profile.units[ancestor];
      if (!ancestorDef?.isStructure) continue;
      ensure(ancestor, depth + 1);
      if (!present.has(ancestor)) {
        const action = actionForName(profile, ancestor);
        if (action) {
          out.push(action);
          present.add(ancestor);
        }
      }
    }
  };
  for (const action of actions) {
    if (action.kind !== "chrono" && action.kind !== "transform-warpgate") {
      ensure(action.name, 0);
    }
    out.push(action);
    present.add(action.name);
  }
  // Gas income goes right after the first structure (before any
  // gas-costing tech, including injected ancestors like a twilight
  // council) so nothing upstream of it can stall on an empty bank.
  if (totalGasCost > 0 && gasName && !out.some((a) => a.name === gasName)) {
    // after the second structure (pylon -> gateway -> gas), or as
    // early as the list allows for very short skeletons
    const buildIndices = out
      .map((a, i) => (a.kind === "build" ? i : -1))
      .filter((i) => i >= 0);
    const anchor = buildIndices[1] ?? buildIndices[0] ?? -1;
    const insertAt = anchor + 1;
    const collectors = totalGasCost > 400 ? 2 : 1;
    for (let i = 0; i < collectors; i += 1) {
      out.splice(insertAt, 0, { kind: "build", name: gasName });
    }
  }
  return out;
}

/**
 * A saved custom build, whichever shape it carries: the legacy
 * `signature` array, or v3 `rules` (the modern editor's format) via
 * the same compression the community timeline uses. Builds saved
 * through the rules editor have no signature — without this fallback
 * most of a user's library is invisible to the adapter. Rules builds
 * additionally get their implied prerequisite chains injected.
 */
export function actionsFromCustomBuild(
  profile: PatchProfile,
  build: {
    signature?: BuildSignatureItem[];
    rules?: BuildRuleLike[];
  },
): ResolvedActions {
  if (build.signature && build.signature.length > 0) {
    const resolved = actionsFromSignature(profile, build.signature);
    return {
      ...resolved,
      latestMilestoneSec: Math.max(
        0,
        ...build.signature.map((s) => s.beforeSec),
      ),
    };
  }
  if (build.rules && build.rules.length > 0) {
    const signature = rulesToSignature(build.rules);
    const resolved = actionsFromSignature(profile, signature);
    return {
      actions: injectPrerequisites(profile, resolved.actions),
      unknownNames: resolved.unknownNames,
      fromRules: true,
      latestMilestoneSec: Math.max(0, ...signature.map((s) => s.beforeSec)),
    };
  }
  return { actions: [], unknownNames: [] };
}

/* ------------------------------------------------------------------ */
/* Adaptation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Match each reference action to its step in a sim by (name, nth
 * occurrence). Policy-driven steps (workers, supply) never collide
 * because policy-owned names are excluded from action lists.
 */
function stepLookup(
  sim: SimResult,
): Map<string, { supply: number; startSec: number }[]> {
  const byName = new Map<string, { supply: number; startSec: number }[]>();
  for (const step of sim.steps) {
    const list = byName.get(step.name) ?? [];
    list.push({ supply: step.supply, startSec: step.startSec });
    byName.set(step.name, list);
  }
  return byName;
}

function buildComparison(
  actions: BuildAction[],
  baselineSim: SimResult,
  adaptedSim: SimResult,
): ComparisonRow[] {
  const baseline = stepLookup(baselineSim);
  const adapted = stepLookup(adaptedSim);
  const seen = new Map<string, number>();
  const rows: ComparisonRow[] = [];
  for (const action of actions) {
    const nth = seen.get(action.name) ?? 0;
    seen.set(action.name, nth + 1);
    const before = baseline.get(action.name)?.[nth];
    const after = adapted.get(action.name)?.[nth];
    rows.push({
      name: action.name,
      kind: action.kind,
      baselineSupply: before?.supply,
      baselineStartSec: before?.startSec,
      adaptedSupply: after?.supply,
      adaptedStartSec: after?.startSec,
      deltaSec:
        before && after
          ? Math.round((after.startSec - before.startSec) * 10) / 10
          : undefined,
    });
  }
  return rows;
}

/**
 * Patch-specific guidance from the adapted sim. The big one for
 * 5.0.16: warpgate research now lives ON the Gateway and occupies it
 * for the full research (PTR-verified), so a legacy build that
 * researches early off one gateway silently loses ~100s of unit
 * production — worth a loud note, not a mystery gap.
 */
function buildAdaptationNotes(
  profile: PatchProfile,
  sim: SimResult,
): string[] {
  const notes: string[] = [];
  const researchSteps = sim.steps.filter((s) => s.kind === "research");
  for (const step of researchSteps) {
    const def = profile.upgrades[step.name];
    if (!def || def.nonBlocking) continue;
    // structures of this type completed when the research started
    const labNames = def.researchedAt;
    let labsAtStart = 0;
    for (const lab of labNames) {
      for (const doneAt of sim.completionTimes[lab] ?? []) {
        if (doneAt <= step.startSec) labsAtStart += 1;
      }
    }
    // does that structure type also train units?
    const trainsUnits = Object.values(profile.units).some(
      (u) => !u.isStructure && u.builtFrom.some((b) => labNames.includes(b)),
    );
    if (trainsUnits && labsAtStart <= 1) {
      notes.push(
        `${humanize(step.name)} occupies your only ${humanize(labNames[0])} from ${mmss(step.startSec)} to ${mmss(step.doneSec)} — no units from it during the research. On this patch most builds wait until the second ${humanize(labNames[0])} finishes before starting it (units first, so you don't die to an attack); dedicated rush builds are the exception.`,
      );
    }
  }
  if (
    sim.race === "Protoss" &&
    (sim.completionTimes.WarpGateResearch?.length ?? 0) > 0 &&
    profile.mechanics.warpgate.transformCost.minerals > 0
  ) {
    const cost = profile.mechanics.warpgate.transformCost;
    const speedPct = Math.round(
      (profile.mechanics.warpgate.gatewaySpeedMultiplier - 1) * 100,
    );
    if (speedPct > 0) {
      notes.push(
        `On this patch, finished warpgate research makes gateways produce ${speedPct}% faster, and transforming to a warpgate costs ${cost.minerals}/${cost.gas} per gateway — transforming everything is no longer automatic. Keep gateways producing; transform when you want to get aggressive or quickly need an extra round of units, then change them to warpgates.`,
      );
    }
  }
  return notes;
}

function mmss(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Re-time `actions` under the target patch, simulate the original
 * patch alongside for the position-by-position comparison, and
 * evaluate the adapted build against the selected threats.
 */
export function adaptBuild(request: AdaptRequest): AdaptResult {
  const baselineProfile = resolveProfile(request.baselineProfileId);
  const targetProfile = resolveProfile(request.profileId);
  const opts = {
    horizonSec: request.horizonSec,
    policies: request.policies,
  };
  const baselineSim = simulate(
    request.actions,
    baselineProfile,
    request.race,
    opts,
  );
  const sim = simulate(request.actions, targetProfile, request.race, opts);
  const safety = evaluateSafety(
    sim,
    targetProfile,
    request.threats,
    request.safety,
  );
  return {
    referenceName: request.referenceName,
    referenceId: request.referenceId,
    actions: request.actions,
    baselineProfileId: request.baselineProfileId,
    profileId: request.profileId,
    sim,
    baselineSim,
    safety,
    comparison: buildComparison(request.actions, baselineSim, sim),
    unknownNames: [],
    adaptationNotes: buildAdaptationNotes(targetProfile, sim),
  };
}
