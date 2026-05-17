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

const PHASE_LIST = PHASE_ORDER;

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

  const hasUnitTimeline = Array.isArray(macroBreakdown.unit_timeline)
    && macroBreakdown.unit_timeline.length > 0;
  if (!hasUnitTimeline) flags.push("unit_timeline_missing");

  const oppBuildLog = Array.isArray(game.oppBuildLog) ? game.oppBuildLog : null;
  if (!oppBuildLog || oppBuildLog.length === 0) {
    flags.push("opp_buildlog_missing");
  }
  const myBuildLog = Array.isArray(game.buildLog) ? game.buildLog : null;
  if (!myBuildLog || myBuildLog.length === 0) {
    flags.push("my_buildlog_missing");
  }

  const oppBuildOrder = buildSideBuildOrder(oppBuildLog || []);
  const myBuildOrder = buildSideBuildOrder(myBuildLog || []);
  const oppTransitions = pickTransitions(classified.crossings);
  const myTransitions = pickTransitions(classifiedMy.crossings);
  const oppCompositionByPhase = sampleCompositionsByPhase(
    macroBreakdown,
    classified.crossings,
    durationSec,
    hasUnitTimeline,
    "opponent",
  );
  const myCompositionByPhase = sampleCompositionsByPhase(
    macroBreakdown,
    classifiedMy.crossings,
    durationSec,
    hasUnitTimeline,
    "you",
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
    myBuildOrder,
    myTransitions,
    myCompositionByPhase,
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
function sampleCompositionsByPhase(
  macroBreakdown,
  crossings,
  durationSec,
  hasUnitTimeline,
  perspective,
) {
  /** @type {Record<string,{reached:boolean,atTime:number|null,units:Array<{token:string,count:number}>}>} */
  const out = {};
  for (const phase of PHASE_LIST) {
    const window = getPhaseWindow(phase, crossings, durationSec);
    if (!window) {
      out[phase] = { reached: false, atTime: null, units: [] };
      continue;
    }
    const midpoint = (window.start + window.end) / 2;
    /** @type {Array<{token:string,count:number}>} */
    let units = [];
    if (hasUnitTimeline) {
      units = pickTopUnits(macroBreakdown, midpoint, perspective);
    }
    out[phase] = {
      reached: true,
      atTime: midpoint,
      units,
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
function pickTopUnits(macroBreakdown, midpoint, perspective) {
  const timeline = Array.isArray(macroBreakdown && macroBreakdown.unit_timeline)
    ? macroBreakdown.unit_timeline
    : [];
  if (timeline.length === 0) return [];
  let best = timeline[0];
  let bestDist = Math.abs(Number(best.time) - midpoint);
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.abs(Number(timeline[i].time) - midpoint);
    if (d < bestDist) {
      best = timeline[i];
      bestDist = d;
    }
  }
  const side = perspective === "opponent"
    ? (best && best.opp ? best.opp : {})
    : (best && best.my ? best.my : {});
  /** @type {Array<{token:string,count:number}>} */
  const entries = [];
  for (const token of Object.keys(side)) {
    if (WORKER_SKIP.has(token)) continue;
    const n = Number(side[token]);
    if (!(n > 0)) continue;
    entries.push({ token, count: n });
  }
  entries.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.token < b.token) return -1;
    if (a.token > b.token) return 1;
    return 0;
  });
  return entries.slice(0, 5);
}

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
};
