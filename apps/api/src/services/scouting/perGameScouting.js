"use strict";

/**
 * perGameScouting — pure compute that builds the per-game envelope the
 * overlay's scouting widget renders for each of the last 5 games
 * against the current opponent.
 *
 * No I/O, no Date, no DB access. Caller hands in the already-loaded
 * stored-game record (the shape ``OpponentsService.get`` keeps on
 * ``rawGames`` before serialisation — gameId, date, map, result,
 * durationSec, myRace, myBuild, opponent.race/displayName/strategy,
 * buildLog/oppBuildLog, macroBreakdown).
 *
 * Returns the canonical ``PerGameScoutingEnvelope`` shape mirrored on
 * the web side under ``apps/web/components/overlay/types.ts`` — the
 * two must agree field-for-field so the wire payload renders
 * unchanged.
 *
 * Degrades gracefully on legacy / partial inputs:
 *   * No ``unit_timeline`` → empty compositions + ``unit_timeline_missing`` flag.
 *   * No ``oppBuildLog`` → empty build order + ``opp_buildlog_missing`` flag.
 *   * ``opp_bases`` empty → re-uses the phase classifier's
 *     ``basesFromExpansionFallback`` and surfaces the
 *     ``opp_bases_synthesized`` flag so the UI can hint that the row
 *     was reconstructed.
 *
 * Never fabricates a fallback composition / build order — if the
 * source data is missing for a given game, that game shows the
 * unavailable badge in the widget.
 */

const { classifyGame, T3_UNITS } = require("../phaseClassifier");
const {
  PHASE_ORDER,
  WORKER_SKIP,
  pickSignatureUnits,
  getPhaseWindow,
} = require("../buildCompositions");
const { tokenByInternalName } = require("../timingCatalog");
const { parseBuildLogLines } = require("../perGameCompute");
const {
  canonicalizeName,
  deriveUnitComposition,
  countBuildingsAt,
  countUpgradesAt,
  sortByCountDesc,
} = require("./compositionAt");

const PHASE_LIST = PHASE_ORDER;

/** Cap on units / buildings / upgrades shipped per phase. The widget
 * renders top-N icons; tighter caps keep the envelope payload bounded
 * on long, varied games against an opponent the user has many games
 * with. Matches the macro-panel roster's visual weight. */
const MAX_UNITS_PER_PHASE = 8;
const MAX_BUILDINGS_PER_PHASE = 10;
const MAX_UPGRADES_PER_PHASE = 8;

/**
 * Back-compat re-exports — the alias map + canonical resolver moved
 * to ``./compositionAt`` so the same module powers both the per-game
 * envelope's variant rollup and the per-phase build-order / upgrade
 * snapshots. Tests that imported these from perGameScouting before
 * the refactor still type-check against the same names.
 */
const {
  UNIT_NAME_ALIASES,
  canonicalizeName: canonicalUnitToken,
} = require("./compositionAt");
const UNIT_TOKEN_ALIASES = UNIT_NAME_ALIASES;

const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;
const BUILD_LOG_NOISE_RE = /^(Beacon|Reward|Spray)/;

/**
 * Unit / building names we never want on the opponent build-order
 * strip. The classifier already drops these from composition
 * snapshots; we drop them here so the build-order strip stays
 * focused on real combat structures + first-of T2/T3 units, never
 * supply / worker / overlord noise.
 *
 * @type {Set<string>}
 */
const BUILD_ORDER_SKIP = new Set([
  // Workers + larva
  "Drone", "SCV", "Probe", "MULE", "Larva",
  // Overlord family — the timeline counts these as units; they're
  // scouting / supply not strategy.
  "Overlord", "OverlordTransport", "OverlordCocoon",
  // Supply / gas structures
  "Pylon", "SupplyDepot", "SupplyDepotLowered",
  "Extractor", "ExtractorRich",
  "Refinery", "RefineryRich",
  // Cancelled / cocoon morph shells — show up as transient rows when
  // an in-flight unit gets nuked or a morph is interrupted.
  "BroodLordCocoon", "RavagerCocoon", "BanelingCocoon",
  "LurkerMPEgg",
]);

/**
 * Compute the per-game scouting envelope from one stored game record.
 *
 * @param {object} game raw game record (NOT the serialized profile
 *   shape — needs ``macroBreakdown``, ``buildLog``, ``oppBuildLog``).
 * @returns {object} PerGameScoutingEnvelope
 */
function computePerGameScouting(game) {
  if (!game || typeof game !== "object") {
    throw new Error("computePerGameScouting: game record required");
  }
  const macroBreakdown = (game.macroBreakdown && typeof game.macroBreakdown === "object")
    ? game.macroBreakdown
    : {};
  const durationSec = Math.max(0, Math.floor(Number(game.durationSec) || 0));
  const opp = game.opponent && typeof game.opponent === "object" ? game.opponent : {};
  const myRace = typeof game.myRace === "string" ? game.myRace : "";
  const oppRace = typeof opp.race === "string" ? opp.race : "";
  const result = canonicalResult(game.result);
  const dateIso = isoDate(game.date);
  const flags = [];

  const classified = classifyGame({
    macroBreakdown,
    race: oppRace || myRace,
    durationSec,
    perspective: "opponent",
  });
  if (classified.basesFromExpansionFallback) {
    flags.push("opp_bases_synthesized");
  }
  const classifiedMy = classifyGame({
    macroBreakdown,
    race: myRace || oppRace,
    durationSec,
    perspective: "you",
  });

  const unitTimeline = Array.isArray(macroBreakdown.unit_timeline)
    ? macroBreakdown.unit_timeline
    : [];
  const hasUnitTimeline = unitTimeline.length > 0;
  if (!hasUnitTimeline) flags.push("unit_timeline_missing");

  const oppBuildLog = Array.isArray(game.oppBuildLog) ? game.oppBuildLog : null;
  if (!oppBuildLog || oppBuildLog.length === 0) {
    flags.push("opp_buildlog_missing");
  }
  const myBuildLog = Array.isArray(game.buildLog) ? game.buildLog : null;
  if (!myBuildLog || myBuildLog.length === 0) {
    flags.push("my_buildlog_missing");
  }

  // Parse the stored build logs into the same event shape the macro
  // breakdown's /v1/games/:id/build-order route emits — categorised
  // (building/unit/upgrade) with tier and complete_time. Catalog is
  // optional (perGameCompute's parser falls back to isKnownBuilding +
  // isKnownUpgrade when absent); the opponent profile path doesn't
  // thread one through so we pass null and rely on the fallback.
  const myEvents = parseBuildLogLines(myBuildLog || [], null);
  const oppEvents = parseBuildLogLines(oppBuildLog || [], null);

  const oppBuildOrder = buildSideBuildOrder(oppBuildLog || []);
  const myBuildOrder = buildSideBuildOrder(myBuildLog || []);
  const oppTransitions = pickTransitions(classified.crossings);
  const myTransitions = pickTransitions(classifiedMy.crossings);
  const oppCompositionByPhase = sampleCompositionsByPhase(
    unitTimeline,
    classified.crossings,
    durationSec,
    "opp",
  );
  const myCompositionByPhase = sampleCompositionsByPhase(
    unitTimeline,
    classifiedMy.crossings,
    durationSec,
    "my",
  );
  const oppBuildingsByPhase = sampleBuildingsByPhase(
    oppEvents,
    classified.crossings,
    durationSec,
  );
  const myBuildingsByPhase = sampleBuildingsByPhase(
    myEvents,
    classifiedMy.crossings,
    durationSec,
  );
  const oppUpgradesByPhase = sampleUpgradesByPhase(
    oppEvents,
    classified.crossings,
    durationSec,
  );
  const myUpgradesByPhase = sampleUpgradesByPhase(
    myEvents,
    classifiedMy.crossings,
    durationSec,
  );
  const endPhase = classified.finalPhase;
  const endReason = deriveEndReason(endPhase, durationSec, result);

  return {
    gameId: String(game.gameId || ""),
    date: dateIso,
    map: typeof game.map === "string" ? game.map : "",
    result,
    durationSec,
    myRace,
    myBuild: typeof game.myBuild === "string" ? game.myBuild : "",
    oppRace,
    oppName: typeof opp.displayName === "string" ? opp.displayName : "",
    oppStrategy: typeof opp.strategy === "string" && opp.strategy
      ? opp.strategy
      : null,
    oppBuildOrder,
    oppTransitions,
    oppCompositionByPhase,
    oppBuildingsByPhase,
    oppUpgradesByPhase,
    myBuildOrder,
    myTransitions,
    myCompositionByPhase,
    myBuildingsByPhase,
    myUpgradesByPhase,
    endPhase,
    endReason,
    flags,
  };
}

/**
 * Normalise the stored result string into the canonical "win" / "loss"
 * / "tie" enum the envelope uses. Treats anything else (missing,
 * "Undecided") as "tie" — the widget renders a neutral chip in that
 * case rather than asserting a winner that doesn't exist.
 *
 * @param {unknown} raw
 * @returns {"win"|"loss"|"tie"}
 */
function canonicalResult(raw) {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "victory" || s === "win") return "win";
  if (s === "defeat" || s === "loss") return "loss";
  return "tie";
}

/**
 * Coerce ``game.date`` (Date or ISO string) into an ISO string. Empty
 * for unparseable inputs — the widget guards on that.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function isoDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString();
  }
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return raw;
  }
  return "";
}

/**
 * Walk one side's stored build-log lines and emit a structured timeline
 * keyed on (name, time, category, tier). Filters out supply / worker /
 * cocoon noise and keeps the first occurrence of each T2/T3 unit name
 * — repeat copies don't add scouting signal once the streamer knows
 * the build is coming. Side-agnostic: applies the same noise filter to
 * the player's own buildLog when invoked for the "my" timeline.
 *
 * @param {string[]} lines
 * @returns {Array<{name:string,time:number,category:"building"|"unit"|"upgrade",tier:1|2|3}>}
 */
function buildSideBuildOrder(lines) {
  /** @type {Array<{name:string,time:number,category:"building"|"unit"|"upgrade",tier:1|2|3}>} */
  const out = [];
  /** @type {Set<string>} */
  const firstSeenUnit = new Set();
  for (const line of lines) {
    const m = BUILD_LOG_LINE_RE.exec(String(line || ""));
    if (!m) continue;
    const rawName = m[3].trim();
    if (BUILD_LOG_NOISE_RE.test(rawName)) continue;
    if (BUILD_ORDER_SKIP.has(rawName)) continue;
    const time = Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
    const entry = tokenByInternalName(rawName);
    /** @type {"building"|"unit"|"upgrade"} */
    let category;
    /** @type {1|2|3} */
    let tier;
    if (entry) {
      category = "building";
      tier = clampTier(entry.tier);
    } else if (isUpgradeName(rawName)) {
      category = "upgrade";
      tier = 2;
    } else {
      category = "unit";
      tier = T3_UNITS.has(rawName) ? 3 : 2;
      if (firstSeenUnit.has(rawName)) continue;
      firstSeenUnit.add(rawName);
    }
    out.push({ name: rawName, time, category, tier });
  }
  out.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  return out;
}

/**
 * Project the classifier's crossings into the envelope shape. Same
 * keys, just lifted to the top of the envelope so the widget doesn't
 * need to remember the nested structure.
 *
 * @param {{earlyMidAt:number|null,midAt:number|null,midLateAt:number|null,lateAt:number|null}} crossings
 */
function pickTransitions(crossings) {
  return {
    earlyMidAt: crossings.earlyMidAt ?? null,
    midAt: crossings.midAt ?? null,
    midLateAt: crossings.midLateAt ?? null,
    lateAt: crossings.lateAt ?? null,
  };
}

/**
 * Build a per-phase composition map. For each of the five phases:
 *   - If the game reached the phase (its start crossing is non-null
 *     OR it's the always-reached ``early`` phase), sample the
 *     ``unit_timeline`` row nearest the phase midpoint and keep the
 *     top 5 non-worker units.
 *   - Otherwise mark ``reached: false`` with empty units.
 *
 * When ``hasUnitTimeline`` is false every phase's units array is
 * empty — the envelope's ``unit_timeline_missing`` flag tells the
 * widget to render an unavailable badge instead of blank cells.
 *
 * @param {object} macroBreakdown
 * @param {{earlyMidAt:number|null,midAt:number|null,midLateAt:number|null,lateAt:number|null}} crossings
 * @param {number} durationSec
 * @param {boolean} hasUnitTimeline
 */
/**
 * Build a per-phase composition map by taking the PEAK alive count
 * per unit across every unit_timeline sample inside the phase
 * window.
 *
 * Why peak alive instead of "build-order cumulative" or "alive at
 * sample-N":
 *   - Sample-N (the macro panel's hover behaviour) can land on a
 *     sparse / post-engagement row and read "1 Carrier" when the
 *     player really fielded 8 during the phase.
 *   - Build-order cumulative grows monotonically without death info
 *     and gives nonsense like "65 Zealots simultaneously" — over
 *     food cap, clearly not real.
 *   - Peak alive walks every sample in the window and surfaces the
 *     high-water mark per canonical unit name. That's the
 *     interpretation a streamer naturally reads off the widget:
 *     "how many of unit X did you have on the field during late
 *     game" — bounded by real food at every sample, plus reflects
 *     the meaningful army composition rather than a transient
 *     post-engagement count.
 *
 * Canonical names are folded via the macro-panel-mirrored alias
 * map (LurkerMP + LurkerMPBurrowed → Lurker, etc.) before max-ing
 * so variants don't split the count.
 *
 * @param {Array<{time:number,my?:object,opp?:object}>} unitTimeline
 * @param {{earlyMidAt:number|null,midAt:number|null,midLateAt:number|null,lateAt:number|null}} crossings
 * @param {number} durationSec
 * @param {"my"|"opp"} side
 */
function sampleCompositionsByPhase(
  unitTimeline,
  crossings,
  durationSec,
  side,
) {
  /** @type {Record<string,{reached:boolean,atTime:number|null,units:Array<{token:string,count:number}>,source:string}>} */
  const out = {};
  const hasTimeline = Array.isArray(unitTimeline) && unitTimeline.length > 0;
  for (const phase of PHASE_LIST) {
    const window = getPhaseWindow(phase, crossings, durationSec);
    if (!window) {
      out[phase] = { reached: false, atTime: null, units: [], source: "empty" };
      continue;
    }
    if (!hasTimeline) {
      out[phase] = {
        reached: true,
        atTime: window.end,
        units: [],
        source: "empty",
      };
      continue;
    }
    const peak = peakAliveInWindow(unitTimeline, window.start, window.end, side);
    const units = sortByCountDesc(peak.counts)
      .filter((row) => !WORKER_SKIP.has(row.name) && row.count > 0)
      .slice(0, MAX_UNITS_PER_PHASE)
      .map((row) => ({ token: row.name, count: row.count }));
    out[phase] = {
      reached: true,
      atTime: peak.atTime,
      units,
      source: peak.sampleCount > 0 ? "timeline" : "empty",
    };
  }
  return out;
}

/**
 * Walk every unit_timeline sample whose ``time`` falls within
 * ``[start, end]`` (inclusive) and accumulate the PEAK alive count
 * per canonical unit name. Returns the peak map AND the timestamp of
 * the sample that contributed the most non-worker units (the
 * "centre of mass" of the engagement window — used by the UI as the
 * cell's atTime so users see a real point in game time rather than
 * a synthetic midpoint).
 *
 * Folds sc2reader variants (LurkerMP / LurkerMPBurrowed / etc.) via
 * ``canonicalizeName`` before max-ing so a stack of burrowed +
 * unburrowed roaches sums into one Roach entry.
 *
 * When the window contains no samples we widen to the NEAREST
 * sample to ``end`` so a tight window that fell between two
 * unit_timeline ticks doesn't render as empty. The atTime returned
 * is the sample's time, not the widened/clamped value.
 *
 * @param {Array<{time:number,my?:object,opp?:object}>} timeline
 * @param {number} start
 * @param {number} end
 * @param {"my"|"opp"} side
 * @returns {{counts:Record<string,number>, atTime:number|null, sampleCount:number}}
 */
function peakAliveInWindow(timeline, start, end, side) {
  /** @type {Map<string, number>} */
  const peak = new Map();
  let atTime = null;
  let bestUnitCount = -1;
  let sampleCount = 0;
  for (const row of timeline) {
    const t = Number(row && row.time);
    if (!Number.isFinite(t)) continue;
    if (t < start || t > end) continue;
    const sideMap = side === "my" ? row.my : row.opp;
    if (!sideMap || typeof sideMap !== "object") continue;
    sampleCount += 1;
    // STEP 1: Fold variants on THIS tick — burrowed + unburrowed forms
    // co-exist on the field, so they sum within a single tick before
    // we compare against the running peak.
    /** @type {Map<string, number>} */
    const perTick = new Map();
    let totalThisRow = 0;
    for (const rawName of Object.keys(sideMap)) {
      if (WORKER_SKIP.has(rawName)) continue;
      const n = Number(sideMap[rawName]);
      if (!(n > 0)) continue;
      const canonical = canonicalizeName(rawName);
      if (!canonical || WORKER_SKIP.has(canonical)) continue;
      perTick.set(canonical, (perTick.get(canonical) || 0) + n);
      totalThisRow += n;
    }
    // STEP 2: Update the running peak per canonical name across ticks.
    for (const [canonical, count] of perTick) {
      const prev = peak.get(canonical) || 0;
      if (count > prev) peak.set(canonical, count);
    }
    if (totalThisRow > bestUnitCount) {
      bestUnitCount = totalThisRow;
      atTime = t;
    }
  }
  if (sampleCount === 0) {
    // Window fell between timeline ticks. Widen by picking the
    // single nearest sample to ``end`` (the phase boundary) and
    // folding its variants the same way.
    let best = null;
    let bestDist = Infinity;
    for (const row of timeline) {
      const t = Number(row && row.time);
      if (!Number.isFinite(t)) continue;
      const d = Math.abs(t - end);
      if (d < bestDist) {
        best = row;
        bestDist = d;
      }
    }
    if (best) {
      const sideMap = side === "my" ? best.my : best.opp;
      if (sideMap && typeof sideMap === "object") {
        for (const rawName of Object.keys(sideMap)) {
          if (WORKER_SKIP.has(rawName)) continue;
          const n = Number(sideMap[rawName]);
          if (!(n > 0)) continue;
          const canonical = canonicalizeName(rawName);
          if (!canonical || WORKER_SKIP.has(canonical)) continue;
          peak.set(canonical, (peak.get(canonical) || 0) + n);
        }
        atTime = Number(best.time) || null;
        sampleCount = 1;
      }
    }
  }
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [name, n] of peak) counts[name] = n;
  return { counts, atTime, sampleCount };
}

/**
 * Per-phase cumulative buildings map. Mirrors the macro panel's
 * ``countBuildingsAt`` snapshot, sampled at the phase end.
 *
 * @param {Array<object>} buildEvents
 * @param {{earlyMidAt:number|null,midAt:number|null,midLateAt:number|null,lateAt:number|null}} crossings
 * @param {number} durationSec
 */
function sampleBuildingsByPhase(buildEvents, crossings, durationSec) {
  /** @type {Record<string,{reached:boolean,atTime:number|null,buildings:Array<{token:string,count:number}>}>} */
  const out = {};
  for (const phase of PHASE_LIST) {
    const window = getPhaseWindow(phase, crossings, durationSec);
    if (!window) {
      out[phase] = { reached: false, atTime: null, buildings: [] };
      continue;
    }
    const sampleAt = Math.max(window.end, window.start);
    const counts = countBuildingsAt(buildEvents, sampleAt);
    const buildings = sortByCountDesc(counts)
      .slice(0, MAX_BUILDINGS_PER_PHASE)
      .map((row) => ({ token: row.name, count: row.count }));
    out[phase] = {
      reached: true,
      atTime: sampleAt,
      buildings,
    };
  }
  return out;
}

/**
 * Per-phase cumulative upgrades map. Mirrors the macro panel's
 * ``countUpgradesAt`` snapshot — tiered weapons/armor families
 * collapse onto the highest tier reached (count value IS the tier).
 *
 * @param {Array<object>} buildEvents
 * @param {{earlyMidAt:number|null,midAt:number|null,midLateAt:number|null,lateAt:number|null}} crossings
 * @param {number} durationSec
 */
function sampleUpgradesByPhase(buildEvents, crossings, durationSec) {
  /** @type {Record<string,{reached:boolean,atTime:number|null,upgrades:Array<{token:string,count:number}>}>} */
  const out = {};
  for (const phase of PHASE_LIST) {
    const window = getPhaseWindow(phase, crossings, durationSec);
    if (!window) {
      out[phase] = { reached: false, atTime: null, upgrades: [] };
      continue;
    }
    const sampleAt = Math.max(window.end, window.start);
    const counts = countUpgradesAt(buildEvents, sampleAt);
    const upgrades = sortByCountDesc(counts)
      .slice(0, MAX_UPGRADES_PER_PHASE)
      .map((row) => ({ token: row.name, count: row.count }));
    out[phase] = {
      reached: true,
      atTime: sampleAt,
      upgrades,
    };
  }
  return out;
}

/**
 * Top 5 (not 3) non-worker units on the requested side at the closest
 * unit_timeline row to ``midpoint``. Used for the per-game scouting
 * snapshot — wider than the dossier's top-3 because the widget has
 * the room and the streamer benefits from seeing the long tail
 * (e.g. the sneaky 2 Ravens hiding behind the Marine ball).
 *
 * @param {object} macroBreakdown
 * @param {number} midpoint
 * @param {"you"|"opponent"} perspective
 * @returns {Array<{token:string,count:number}>}
 */
/**
 * Map (endPhase, durationSec, result) onto the structured endReason
 * enum the widget chips render. Applied in priority order — first
 * match wins — so the boundaries line up with the contract in the
 * envelope's type comment.
 *
 * @param {string} endPhase
 * @param {number} durationSec
 * @param {"win"|"loss"|"tie"} result
 * @returns {"early_allin"|"early_loss"|"early_win"|"midgame_engagement"|"macro_game"|"unknown"}
 */
function deriveEndReason(endPhase, durationSec, result) {
  if (endPhase === "early") {
    if (durationSec < 240) return "early_allin";
    if (result === "loss") return "early_loss";
    if (result === "win") return "early_win";
    return "unknown";
  }
  if (endPhase === "earlyMid" || endPhase === "mid") {
    if (durationSec < 540) return "midgame_engagement";
    return "unknown";
  }
  if (endPhase === "midLate" || endPhase === "late") {
    return "macro_game";
  }
  return "unknown";
}

/**
 * @param {unknown} raw
 * @returns {1|2|3}
 */
function clampTier(raw) {
  const n = Number(raw);
  if (n === 3) return 3;
  if (n === 2) return 2;
  return 1;
}

/**
 * Crude upgrade-name detector for build-log lines that aren't in the
 * timing catalog. The shared upgrade detector
 * (``perGameCompute.isKnownUpgrade``) couples to an internal catalog;
 * for the scouting envelope we only need to flip the ``category`` tag
 * so the widget knows to render the upgrade-style icon, and the
 * heuristic below matches Blizzard's upgrade-name convention closely
 * enough (Level\d / Weapons / Armor / Carapace / Glaive / Speed /
 * Burrow / etc.) without dragging in the full catalog dependency
 * graph.
 *
 * @param {string} name
 */
function isUpgradeName(name) {
  if (!name) return false;
  return /Level\d|Weapons|Armor|Carapace|Glaive|Charge|Resonating|Extended|Stim|Combat|Concussive|Hi-Sec|Drilling|Burrow|TunnelingClaws|MetabolicBoost|AdrenalGlands|FlyerAttacks|FlyerArmor|GroundAttacks|GroundArmor|MissileAttacks|Centrifugal|ChitinousPlating|PathogenGlands|NeuralParasite|InfestorEnergyUpgrade/i.test(name);
}

module.exports = {
  computePerGameScouting,
  deriveEndReason,
  buildSideBuildOrder,
  // Back-compat alias — older tests / callers may still import this
  // under the original opponent-only name.
  buildOpponentBuildOrder: buildSideBuildOrder,
  BUILD_ORDER_SKIP,
  canonicalUnitToken,
  UNIT_TOKEN_ALIASES,
};
