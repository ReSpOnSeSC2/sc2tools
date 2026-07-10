"use strict";

/**
 * Server-side port of
 * ``apps/web/components/analyzer/macro/compositionAt.ts``.
 *
 * The macro-breakdown panel runs this logic in the browser to derive
 * its alive-unit / buildings / upgrades roster from one game's
 * macroBreakdown + parsed buildLog. The opponent-profile per-game
 * scouting widget needs the same numbers across every game in the
 * profile, so we run the identical derivation server-side and ship
 * the results in the scouting envelope.
 *
 * Keep this file in sync with the TS module — every map, regex, and
 * fallback branch mirrors the client implementation field-for-field.
 * The tests in ``apps/api/__tests__/scoutingCompositionAt.test.js``
 * pin the parity behaviour against the macro-panel-style fixtures.
 *
 * Pure compute — no I/O, no Date, no logging. The macro-breakdown
 * resolution order is preserved exactly:
 *   1. unit_timeline at the nearest sample (alive count, death-aware).
 *   2. Build-order cumulative + timeline-derived deaths.
 *   3. Build-order cumulative alone (no death info available).
 *   4. Empty when neither source carries data.
 */

const PHASE_LIST = ["early", "earlyMid", "mid", "midLate", "late"];

/**
 * Worker / drone family — these are filtered out of the army roster
 * by the macro panel via ``isWorkerUnit`` in lib/sc2-units. The set
 * mirrors WORKER_NAMES from that module.
 *
 * @type {Set<string>}
 */
const WORKER_NAMES = new Set(["Drone", "SCV", "Probe", "MULE"]);

/**
 * Unit morph parent map — when key X is built, it consumes one of the
 * mapped parent. Used so a Hydralisk that morphed into a Lurker counts
 * as one Lurker, not Hydralisk + Lurker. Mirrors UNIT_MORPH_PARENT in
 * compositionAt.ts.
 *
 * @type {Record<string, string>}
 */
const UNIT_MORPH_PARENT = {
  // Zerg
  Lurker: "Hydralisk",
  LurkerMP: "Hydralisk",
  Ravager: "Roach",
  Baneling: "Zergling",
  BroodLord: "Corruptor",
  Broodlord: "Corruptor",
  Overseer: "Overlord",
};

const ARCHON_PARENTS = ["DarkTemplar", "HighTemplar"];

/**
 * Building morph parent map — Lair from Hatchery, Hive from Lair, etc.
 * Mirrors BUILDING_MORPH_PARENT in compositionAt.ts.
 *
 * @type {Record<string, string>}
 */
const BUILDING_MORPH_PARENT = {
  Lair: "Hatchery",
  Hive: "Lair",
  GreaterSpire: "Spire",
  LurkerDen: "HydraliskDen",
  LurkerDenMP: "HydraliskDen",
  OrbitalCommand: "CommandCenter",
  PlanetaryFortress: "CommandCenter",
  WarpGate: "Gateway",
};

/**
 * sc2reader unit-name alias table. Mirrors UNIT_NAME_ALIASES in
 * compositionAt.ts. Keep additions synchronised with the TS file —
 * the macro-breakdown roster and the per-game scouting envelope MUST
 * canonicalise variants identically.
 *
 * @type {Map<string, string>}
 */
const UNIT_NAME_ALIASES = new Map([
  // Terran combat-posture / stance variants
  ["SiegeTankSieged", "SiegeTank"],
  ["VikingFighter", "Viking"],
  ["VikingAssault", "Viking"],
  ["HellionTank", "Hellbat"],
  ["ThorAP", "Thor"],
  ["ThorAA", "Thor"],
  ["WidowMineBurrowed", "WidowMine"],
  ["LiberatorAG", "Liberator"],
  // Protoss warp-in cocoon variants and stance toggles
  ["WarpPrismPhasing", "WarpPrism"],
  ["ZealotWarp", "Zealot"],
  ["StalkerWarp", "Stalker"],
  ["SentryWarp", "Sentry"],
  ["AdeptWarp", "Adept"],
  ["AdeptPhaseShift", "Adept"],
  ["DarkTemplarWarp", "DarkTemplar"],
  ["HighTemplarWarp", "HighTemplar"],
  ["ImmortalWarp", "Immortal"],
  ["ColossusWarp", "Colossus"],
  ["ObserverSiegeMode", "Observer"],
  // Zerg burrow / MP / cocoon variants
  ["BanelingMP", "Baneling"],
  ["BanelingBurrowed", "Baneling"],
  ["BanelingCocoon", "Baneling"],
  ["RoachBurrowed", "Roach"],
  ["RoachMP", "Roach"],
  ["ZerglingBurrowed", "Zergling"],
  ["HydraliskBurrowed", "Hydralisk"],
  ["InfestorBurrowed", "Infestor"],
  ["LurkerMP", "Lurker"],
  ["LurkerMPBurrowed", "Lurker"],
  ["LurkerMPEgg", "Lurker"],
  ["LurkerBurrowed", "Lurker"],
  ["RavagerBurrowed", "Ravager"],
  ["RavagerCocoon", "Ravager"],
  ["SwarmHostMP", "SwarmHost"],
  ["SwarmHostMPBurrowed", "SwarmHost"],
  ["SwarmHostBurrowedMP", "SwarmHost"],
  ["QueenBurrowed", "Queen"],
  ["UltraliskBurrowed", "Ultralisk"],
  ["BroodLordCocoon", "BroodLord"],
  ["Broodlord", "BroodLord"],
  ["OverseerSiegeMode", "Overseer"],
  ["OverseerCocoon", "Overseer"],
  ["OverlordTransport", "Overlord"],
  ["OverlordTransportCocoon", "Overlord"],
  ["TransportOverlordCocoon", "Overlord"],
  ["LocustMP", "Locust"],
  ["LocustMPFlying", "Locust"],
  ["LocustMPPrecursor", "Locust"],
  ["DroneBurrowed", "Drone"],
]);

const UNIT_NAME_SUFFIX_RE = /(Burrowed|Sieged|Phasing|Flying|Lowered|Cocoon|Uprooted|Phased)$/i;
const UNIT_NAME_PREFIX_BURROWED_RE = /^Burrowed/i;

/**
 * Canonicalise an sc2reader unit / building token. Same three-step
 * resolution as the macro panel: alias hit → suffix strip → second
 * alias pass on the stripped name → pass-through.
 *
 * @param {string} name
 * @returns {string}
 */
function canonicalizeName(name) {
  if (!name) return "";
  const direct = UNIT_NAME_ALIASES.get(name);
  if (direct) return direct;
  const stripped = String(name)
    .replace(UNIT_NAME_SUFFIX_RE, "")
    .replace(UNIT_NAME_PREFIX_BURROWED_RE, "");
  if (stripped !== name) {
    const aliased = UNIT_NAME_ALIASES.get(stripped);
    if (aliased) return aliased;
  }
  return stripped || name;
}

/**
 * Fold a ``{name: count}`` map onto canonical names — collapses
 * burrowed / morph variants into one entry. Mirrors ``folded`` in
 * compositionAt.ts.
 *
 * @param {Record<string, number>} composition
 * @returns {Record<string, number>}
 */
function folded(composition) {
  const out = {};
  if (!composition || typeof composition !== "object") return out;
  for (const name of Object.keys(composition)) {
    const count = Number(composition[name]) || 0;
    if (count <= 0) continue;
    const canonical = canonicalizeName(name);
    if (!canonical) continue;
    out[canonical] = (out[canonical] || 0) + count;
  }
  return out;
}

/**
 * Apply the morph rule for one build-order event. Mutates ``counts``
 * to consume the morph parent (if present and positive). Returns the
 * canonical name to credit on the output map.
 *
 * @param {Record<string, number>} counts
 * @param {string} rawName
 * @returns {string}
 */
function applyMorph(counts, rawName) {
  const canonical = canonicalizeName(rawName);
  if (canonical === "Archon") {
    let consumed = 0;
    for (const parent of ARCHON_PARENTS) {
      while (consumed < 2 && (counts[parent] || 0) > 0) {
        counts[parent] -= 1;
        if (counts[parent] === 0) delete counts[parent];
        consumed += 1;
      }
      if (consumed >= 2) break;
    }
    return canonical;
  }
  const parent = UNIT_MORPH_PARENT[canonical];
  if (parent && (counts[parent] || 0) > 0) {
    counts[parent] -= 1;
    if (counts[parent] === 0) delete counts[parent];
  }
  return canonical;
}

/**
 * Cumulative non-worker, non-building unit count from a build-order
 * event stream up to and including ``t``. Mirrors
 * ``buildOrderUnitsAt`` in compositionAt.ts.
 *
 * @param {Array<{time:number,name:string,display?:string,is_building?:boolean,category?:string}>} events
 * @param {number} t
 * @returns {Record<string, number>}
 */
function buildOrderUnitsAt(events, t) {
  if (!Array.isArray(events) || events.length === 0) return {};
  /** @type {Record<string, number>} */
  const counts = {};
  for (const ev of events) {
    if (!ev || ev.is_building) continue;
    const time = Number(ev.time) || 0;
    if (time > t) break;
    const rawName = ev.name || ev.display || "";
    if (!rawName) continue;
    const canonical = canonicalizeName(rawName);
    if (!canonical) continue;
    if (WORKER_NAMES.has(canonical)) continue;
    // Upgrades aren't units — the build-order parser tags every research
    // event with category=upgrade; skip them here so countUpgradesAt
    // handles them separately.
    if ((ev.category || "").toLowerCase() === "upgrade") continue;
    const credited = applyMorph(counts, rawName);
    counts[credited] = (counts[credited] || 0) + 1;
  }
  return counts;
}

/**
 * Derive death events for one side by diffing consecutive
 * unit_timeline samples. When unit X drops from N to M between two
 * samples, we record (N - M) deaths attributed to the later sample's
 * time. Mirrors ``derivedDeathsFromTimeline`` in compositionAt.ts.
 *
 * @param {Array<{time:number,my?:Record<string,number>,opp?:Record<string,number>}>} timeline
 * @param {"my"|"opp"} side
 * @returns {Array<{time:number,name:string,count:number}>}
 */
function derivedDeathsFromTimeline(timeline, side) {
  if (!Array.isArray(timeline) || timeline.length < 2) return [];
  /** @type {Array<{time:number,name:string,count:number}>} */
  const out = [];
  for (let i = 1; i < timeline.length; i++) {
    const prevSide = side === "my" ? timeline[i - 1].my : timeline[i - 1].opp;
    const curSide = side === "my" ? timeline[i].my : timeline[i].opp;
    if (!prevSide && !curSide) continue;
    const prev = prevSide || {};
    const cur = curSide || {};
    const prevHasUnits = Object.keys(prev).length > 0;
    const curHasUnits = Object.keys(cur).length > 0;
    if (prevHasUnits && !curHasUnits) {
      const prevOther = side === "my" ? timeline[i - 1].opp : timeline[i - 1].my;
      const curOther = side === "my" ? timeline[i].opp : timeline[i].my;
      const prevOtherHasUnits = prevOther && Object.keys(prevOther).length > 0;
      const curOtherHasUnits = curOther && Object.keys(curOther).length > 0;
      if (prevOtherHasUnits && !curOtherHasUnits) continue;
    }
    /** @type {Set<string>} */
    const seen = new Set();
    for (const name of Object.keys(prev)) seen.add(name);
    for (const name of Object.keys(cur)) seen.add(name);
    for (const name of seen) {
      const prevCount = prev[name] || 0;
      const curCount = cur[name] || 0;
      if (curCount < prevCount) {
        out.push({
          time: Number(timeline[i].time) || 0,
          name,
          count: prevCount - curCount,
        });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Closest unit_timeline entry to ``t``.
 *
 * @param {Array<{time:number}>} timeline
 * @param {number} t
 * @returns {object|null}
 */
function nearestTimelineEntry(timeline, t) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  let best = timeline[0];
  let bestD = Math.abs((Number(best.time) || 0) - t);
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.abs((Number(timeline[i].time) || 0) - t);
    if (d < bestD) {
      best = timeline[i];
      bestD = d;
    }
  }
  return best;
}

/**
 * Mirror of ``deriveUnitComposition`` in compositionAt.ts. Picks the
 * best source for the alive-unit roster at game-time ``t`` and
 * returns ``{units, source}``. Source values match the TS module so
 * downstream tooling can branch identically.
 *
 * @param {{
 *   timeline: Array<{time:number,my?:Record<string,number>,opp?:Record<string,number>}> | null | undefined,
 *   buildEvents: Array<{time:number,name:string,is_building?:boolean,category?:string}> | null | undefined,
 *   side: "my"|"opp",
 *   t: number,
 * }} opts
 * @returns {{units: Record<string,number>, source: "timeline"|"hybrid"|"build_order"|"empty"}}
 */
function deriveUnitComposition(opts) {
  const { timeline, buildEvents, side, t } = opts;
  const hasTimeline = Array.isArray(timeline) && timeline.length > 0;
  const hasBuildEvents = Array.isArray(buildEvents) && buildEvents.length > 0;

  if (hasTimeline) {
    const entry = nearestTimelineEntry(timeline, t);
    const composition = (side === "my" ? entry && entry.my : entry && entry.opp) || {};
    if (Object.keys(composition).length > 0) {
      return { units: folded(composition), source: "timeline" };
    }
  }

  if (!hasBuildEvents) {
    return { units: {}, source: "empty" };
  }
  const built = buildOrderUnitsAt(buildEvents, t);

  if (!hasTimeline) {
    return { units: built, source: "build_order" };
  }

  const deaths = derivedDeathsFromTimeline(timeline, side);
  let appliedAny = false;
  for (const death of deaths) {
    if (death.time > t) break;
    const canonical = canonicalizeName(death.name);
    const cur = built[canonical] || 0;
    if (cur > 0) {
      const next = Math.max(0, cur - death.count);
      if (next === 0) delete built[canonical];
      else built[canonical] = next;
      appliedAny = true;
    }
  }
  return {
    units: built,
    source: appliedAny ? "hybrid" : "build_order",
  };
}

/**
 * Cumulative buildings-built map from a build-order event stream up
 * to and including ``t``. Mirrors ``countBuildingsAt`` in
 * compositionAt.ts: canonicalises stance suffixes and consumes the
 * morph predecessor so a hatchery → lair → hive chain reads as
 * "1 Hive", not "1 Hatchery + 1 Lair + 1 Hive".
 *
 * @param {Array<{time:number,name:string,is_building?:boolean}>} events
 * @param {number} t
 * @returns {Record<string, number>}
 */
function countBuildingsAt(events, t) {
  if (!Array.isArray(events) || events.length === 0) return {};
  /** @type {Record<string, number>} */
  const counts = {};
  // Once WarpGate research completes, every existing Gateway auto-morphs
  // into a Warp Gate (≈7 s transition per building) and any Gateway built
  // afterwards morphs on completion. WarpGate UnitTypeChangeEvent entries
  // in the build log consume a Gateway per morph, but residual Gateways
  // can still leak through (in-flight construction at the hovered time,
  // or a morph event missing from a slim/truncated payload). Fold the
  // residual Gateway count into WarpGate once the research has completed
  // so the roster shows a single "WarpGate × N" chip — mirrors the same
  // fold in apps/web/components/analyzer/macro/compositionAt.ts.
  let warpGateResearchComplete = false;
  for (const ev of events) {
    if (!ev) continue;
    const startTime = Number(ev.time) || 0;
    if (startTime > t) break;
    if (ev.is_building) {
      const raw = ev.name || ev.display || "";
      if (!raw) continue;
      const canonical = canonicalizeName(raw);
      if (!canonical) continue;
      const prev = BUILDING_MORPH_PARENT[canonical];
      if (prev && (counts[prev] || 0) > 0) {
        counts[prev] -= 1;
        if (counts[prev] === 0) delete counts[prev];
      }
      counts[canonical] = (counts[canonical] || 0) + 1;
    } else if ((ev.category || "").toLowerCase() === "upgrade") {
      const name = ev.name || ev.display || "";
      if (name === "WarpGateResearch") {
        const completeTime = Number(
          ev.complete_time != null ? ev.complete_time : ev.time,
        ) || 0;
        if (completeTime <= t) warpGateResearchComplete = true;
      }
    }
  }
  if (warpGateResearchComplete && (counts.Gateway || 0) > 0) {
    counts.WarpGate = (counts.WarpGate || 0) + counts.Gateway;
    delete counts.Gateway;
  }
  return counts;
}

/**
 * Derive structure-death events from a ``production_buildings`` array.
 * Mirrors ``derivedBuildingDeaths`` in compositionAt.ts.
 *
 * Current records carry an explicit ``destroyed`` bit. Older records lack
 * it, so they retain the maximum-``died_time`` sentinel fallback used by
 * the browser implementation.
 *
 * @param {Array<{name:string,born_time:number,died_time:number,destroyed?:boolean}>} records
 * @returns {Array<{time:number,name:string,count:number}>}
 */
function derivedBuildingDeaths(records) {
  if (!Array.isArray(records) || records.length === 0) return [];
  let sentinel = 0;
  for (const r of records) {
    const died = Number(r && r.died_time);
    if (Number.isFinite(died) && died > sentinel) sentinel = died;
  }
  /** @type {Array<{time:number,name:string,count:number}>} */
  const out = [];
  for (const r of records) {
    if (!r) continue;
    const died = Number(r.died_time);
    const born = Number(r.born_time) || 0;
    if (!Number.isFinite(died)) continue;
    const isDestroyed =
      typeof r.destroyed === "boolean"
        ? r.destroyed
        : sentinel > 0 && died < sentinel;
    if (!isDestroyed) continue;
    if (died < born) continue;
    const canonical = canonicalizeName(r.name || "");
    if (!canonical) continue;
    out.push({ time: died, name: canonical, count: 1 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Decrement one structure death from the cumulative ``counts`` map,
 * with a Gateway ↔ WarpGate fallback so a Gateway destroyed before
 * WarpGate research (folded into WarpGate by ``countBuildingsAt`` at
 * game end) still finds a bucket. Mirrors ``subtractBuildingDeath`` in
 * compositionAt.ts.
 *
 * @param {Record<string, number>} counts
 * @param {string} name
 * @param {number} amount
 * @returns {boolean}
 */
function subtractBuildingDeath(counts, name, amount) {
  const tryBucket = (key) => {
    const cur = counts[key] || 0;
    if (cur <= 0) return false;
    const next = Math.max(0, cur - amount);
    if (next === 0) delete counts[key];
    else counts[key] = next;
    return true;
  };
  if (tryBucket(name)) return true;
  if (name === "Gateway") return tryBucket("WarpGate");
  if (name === "WarpGate") return tryBucket("Gateway");
  return false;
}

/**
 * Death-aware Buildings roster at time ``t``: the cumulative
 * build-order count minus every structure destroyed at or before
 * ``t`` (read from ``production_buildings``). Mirrors
 * ``deriveBuildingComposition`` in compositionAt.ts. Falls back to the
 * cumulative count (source ``build_order``) when no production-building
 * lifetimes are available.
 *
 * @param {{
 *   buildEvents: Array<object> | null | undefined,
 *   productionBuildings: Array<{name:string,born_time:number,died_time:number,destroyed?:boolean}> | null | undefined,
 *   t: number,
 * }} opts
 * @returns {{buildings: Record<string, number>, source: "alive"|"build_order"}}
 */
function deriveBuildingComposition(opts) {
  const { buildEvents, productionBuildings, t } = opts;
  const built = countBuildingsAt(buildEvents, t);
  if (!Array.isArray(productionBuildings) || productionBuildings.length === 0) {
    return { buildings: built, source: "build_order" };
  }
  const deaths = derivedBuildingDeaths(productionBuildings);
  for (const death of deaths) {
    if (death.time > t) break;
    subtractBuildingDeath(built, death.name, death.count);
  }
  return { buildings: built, source: "alive" };
}

/**
 * Identify a tiered upgrade family. Returns {family, tier} for
 * weapons/armor/shields/carapace research events, null for everything
 * else. Mirrors ``tieredUpgradeFamily`` in compositionAt.ts.
 *
 * @param {string} rawName
 * @returns {{family:string,tier:number}|null}
 */
function tieredUpgradeFamily(rawName) {
  const m = /^(.+?)level([1-3])$/i.exec(rawName);
  if (!m) return null;
  let family = m[1]
    .toLowerCase()
    .replace(/vanadiumplating$/, "")
    .replace(/ultracapacitors$/, "");
  family = family
    .replace(/^terranvehicleandshipplating$/, "terranvehiclearmor")
    .replace(/^terranvehicleandshiparmors?$/, "terranvehiclearmor")
    .replace(/^terranshiparmors?$/, "terranvehiclearmor");
  family = family
    .replace(/armors$/, "armor")
    .replace(/attacks$/, "weapons")
    .replace(/carapace$/, "armor");
  return { family, tier: Number(m[2]) };
}

/**
 * Cumulative upgrades map up to ``t``. For tiered weapons/armor
 * families, only the highest tier reached is emitted (the chip's
 * count IS the tier — "+2 Ground Weapons" reads as "Ground Weapons
 * x2"). Mirrors ``countUpgradesAt`` in compositionAt.ts.
 *
 * @param {Array<{time:number,complete_time?:number,name:string,is_building?:boolean,category?:string}>} events
 * @param {number} t
 * @returns {Record<string, number>}
 */
function countUpgradesAt(events, t) {
  if (!Array.isArray(events) || events.length === 0) return {};
  /** @type {Map<string,{name:string,tier:number}>} */
  const tieredByFamily = new Map();
  /** @type {Record<string, number>} */
  const nonTieredCounts = {};
  for (const ev of events) {
    if (!ev) continue;
    if (ev.is_building) continue;
    if ((ev.category || "").toLowerCase() !== "upgrade") continue;
    const time = Number(ev.complete_time != null ? ev.complete_time : ev.time) || 0;
    if (time > t) continue;
    const raw = ev.name || ev.display || "";
    if (!raw) continue;
    const tiered = tieredUpgradeFamily(raw);
    if (tiered) {
      const prev = tieredByFamily.get(tiered.family);
      if (!prev || tiered.tier > prev.tier) {
        tieredByFamily.set(tiered.family, { name: raw, tier: tiered.tier });
      }
      continue;
    }
    nonTieredCounts[raw] = (nonTieredCounts[raw] || 0) + 1;
  }
  /** @type {Record<string, number>} */
  const counts = { ...nonTieredCounts };
  for (const { name, tier } of tieredByFamily.values()) {
    counts[name] = tier;
  }
  return counts;
}

/**
 * Sort a ``{name: count}`` map by count desc / name asc. Mirrors
 * ``sortByCountDesc`` in compositionAt.ts.
 *
 * @param {Record<string, number> | null | undefined} counts
 * @returns {Array<{name:string,count:number}>}
 */
function sortByCountDesc(counts) {
  if (!counts) return [];
  /** @type {Array<{name:string,count:number}>} */
  const entries = [];
  for (const name of Object.keys(counts)) {
    const count = Number(counts[name]) || 0;
    if (count <= 0) continue;
    entries.push({ name, count });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

module.exports = {
  PHASE_LIST,
  WORKER_NAMES,
  UNIT_NAME_ALIASES,
  UNIT_MORPH_PARENT,
  BUILDING_MORPH_PARENT,
  canonicalizeName,
  folded,
  buildOrderUnitsAt,
  derivedDeathsFromTimeline,
  nearestTimelineEntry,
  deriveUnitComposition,
  countBuildingsAt,
  derivedBuildingDeaths,
  deriveBuildingComposition,
  countUpgradesAt,
  tieredUpgradeFamily,
  sortByCountDesc,
  peakAliveInWindow,
};

/**
 * Walk every unit_timeline sample whose ``time`` falls within
 * ``[start, end]`` (inclusive) and accumulate the PEAK alive count
 * per canonical unit name. Variants on the same tick (Lurker +
 * LurkerMP + LurkerMPBurrowed for a stack of lurkers) are SUMMED
 * within the tick before the peak is taken across ticks — so a
 * burrow/unburrow oscillation never double-counts, AND a stacked
 * morph army on a single tick reads as the real on-field total.
 *
 * Skips worker / supply / overlord noise per ``skip`` (defaults to
 * ``WORKER_NAMES``) before folding. When the window contains no
 * samples, widens to the single NEAREST sample to ``end`` so a
 * tight window that fell between two timeline ticks doesn't render
 * empty.
 *
 * Mirrors the macro-breakdown panel's "alive units while the player
 * was in this phase" reading — not a single-tick snapshot, not a
 * cumulative-built count.
 *
 * @param {Array<{time:number,my?:object,opp?:object}>} timeline
 * @param {number} start
 * @param {number} end
 * @param {"my"|"opp"} side
 * @param {Set<string>} [skip] worker / noise tokens to drop before fold
 * @returns {{counts:Record<string,number>, atTime:number|null, sampleCount:number}}
 */
function peakAliveInWindow(timeline, start, end, side, skip) {
  const ignore = skip instanceof Set ? skip : WORKER_NAMES;
  /** @type {Map<string, number>} */
  const peak = new Map();
  let atTime = null;
  let bestUnitCount = -1;
  let sampleCount = 0;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return { counts: {}, atTime: null, sampleCount: 0 };
  }
  for (const row of timeline) {
    const t = Number(row && row.time);
    if (!Number.isFinite(t)) continue;
    if (t < start || t > end) continue;
    const sideMap = side === "my" ? row.my : row.opp;
    if (!sideMap || typeof sideMap !== "object") continue;
    sampleCount += 1;
    /** @type {Map<string, number>} */
    const perTick = new Map();
    let totalThisRow = 0;
    for (const rawName of Object.keys(sideMap)) {
      if (ignore.has(rawName)) continue;
      const n = Number(sideMap[rawName]);
      if (!(n > 0)) continue;
      const canonical = canonicalizeName(rawName);
      if (!canonical || ignore.has(canonical)) continue;
      perTick.set(canonical, (perTick.get(canonical) || 0) + n);
      totalThisRow += n;
    }
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
          if (ignore.has(rawName)) continue;
          const n = Number(sideMap[rawName]);
          if (!(n > 0)) continue;
          const canonical = canonicalizeName(rawName);
          if (!canonical || ignore.has(canonical)) continue;
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
