"use strict";

/**
 * autoClassify/deriveBuild — Promote a candidate cluster into a v3
 * rule set + human build name. Reuses extractSignature so derived
 * timings share the rule engine's anti-hallucination filter. Pure:
 * deterministic in the inputs. See deriveRules and deriveName below.
 */

const {
  evaluateRules,
  UNIT_TECH_PREREQUISITES,
} = require("../buildRulesEvaluator");
const { extractSignature } = require("./signature");

const VERB_PREFIX_RE = /^(Build|Train|Research|Morph)(?=[A-Z])/;

/**
 * Bare-noun → display label. Entries equal to the bare noun are
 * omitted; {@link displayNoun} falls back to the bare noun.
 */
const DISPLAY_NOUN = {
  RoboticsFacility: "Robo", RoboticsBay: "Robo Bay",
  TwilightCouncil: "Twilight", DarkShrine: "Dark Shrine",
  TemplarArchive: "Templar", FleetBeacon: "Fleet Beacon",
  CyberneticsCore: "Cyber", VoidRay: "Void Ray", WarpPrism: "Warp Prism",
  DarkTemplar: "DT", HighTemplar: "HT", GreaterSpire: "Greater Spire",
  HydraliskDen: "Hydra Den", RoachWarren: "Roach Warren",
  BanelingNest: "Baneling Nest", LurkerDen: "Lurker Den",
  InfestationPit: "Infestation", UltraliskCavern: "Ultralisk Cavern",
  NydusNetwork: "Nydus", SpawningPool: "Pool", EvolutionChamber: "Evo",
  Hydralisk: "Hydra", Mutalisk: "Muta", BroodLord: "Brood Lord",
  SwarmHostMP: "Swarm Host", Zergling: "Ling", Barracks: "Rax",
  GhostAcademy: "Ghost Academy", FusionCore: "Fusion Core",
  EngineeringBay: "EBay", SiegeTank: "Tank", Battlecruiser: "BC",
  WidowMine: "Widow Mine", VikingFighter: "Viking",
};

/** Protoss prereqs every macro game emits — skip when naming. */
const UNIVERSAL_OPEN_BARE = new Set(["Gateway", "CyberneticsCore"]);

/**
 * Alternative tech buildings keyed by lead tech (priority order).
 * First alternative whose cluster presence is ≤ RARE_TOKEN_THRESHOLD
 * wins the not_before slot.
 */
const TECH_ALTERNATIVES = {
  BuildStargate: ["BuildRoboticsFacility", "BuildTwilightCouncil"],
  BuildRoboticsFacility: ["BuildStargate", "BuildTwilightCouncil"],
  BuildTwilightCouncil: ["BuildStargate", "BuildRoboticsFacility"],
  BuildDarkShrine: ["BuildStargate", "BuildRoboticsFacility"],
  BuildTemplarArchive: ["BuildStargate", "BuildRoboticsFacility"],
  BuildSpire: ["BuildRoachWarren", "BuildHydraliskDen"],
  BuildRoachWarren: ["BuildSpire", "BuildHydraliskDen"],
  BuildHydraliskDen: ["BuildRoachWarren", "BuildSpire"],
  BuildLurkerDen: ["BuildSpire"],
  BuildInfestationPit: ["BuildSpire", "BuildHydraliskDen"],
  BuildStarport: ["BuildFactory"],
  BuildFactory: ["BuildStarport"],
};

/**
 * Per-token "fast" thresholds (sec). p50 below → "(Fast)" suffix.
 * Picked at the lower edge of typical timing windows so "standard"
 * openings (e.g. Stargate at 3:20) don't accidentally read as fast.
 */
const FAST_THRESHOLDS = {
  BuildStargate: 195, BuildRoboticsFacility: 195, BuildTwilightCouncil: 240,
  BuildDarkShrine: 300, BuildTemplarArchive: 300, BuildFleetBeacon: 330,
  BuildRoboticsBay: 330, BuildSpire: 360, BuildHydraliskDen: 240,
  BuildRoachWarren: 180, BuildLurkerDen: 360, BuildFactory: 240,
  BuildStarport: 300,
};

const SHARED_TOKEN_THRESHOLD = 0.8;
const RARE_TOKEN_THRESHOLD = 0.2;
const MIN_SELF_MATCH_RATE = 0.9;
const MAX_DERIVED_RULES = 6;
const MAX_RELAX_PASSES = 3;
const NOT_BEFORE_DEFAULT_SEC = 480;

function bareNoun(token) {
  return typeof token === "string" ? token.replace(VERB_PREFIX_RE, "") : "";
}

function displayNoun(token) {
  const bare = bareNoun(token);
  return DISPLAY_NOUN[bare] || bare;
}

function percentile(arr, p) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx];
}

/** Smallest multiple of 15 ≥ sec, clamped to [15, 1800]. */
function clampTimeLt(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return 15;
  const r = Math.ceil(s / 15) * 15;
  if (r < 15) return 15;
  if (r > 1800) return 1800;
  return r;
}

/** FNV-1a 32-bit → base36, padded/truncated to 6 chars. */
function shortHash(input) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(-6);
}

function kebabCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isUnitToken(token) {
  return Object.prototype.hasOwnProperty.call(
    UNIT_TECH_PREREQUISITES,
    bareNoun(token),
  );
}

/** Per-token first-occurrence times + presence across the cluster. */
function indexCluster(clusterGames) {
  const tokenFirstTimes = new Map();
  const tokenPresence = new Map();
  for (const g of clusterGames) {
    const events = g && Array.isArray(g.events) ? g.events : [];
    const sig = extractSignature(events);
    for (const entry of sig) {
      if (!entry || typeof entry.token !== "string") continue;
      const t = Number(entry.t);
      if (!Number.isFinite(t)) continue;
      if (!tokenFirstTimes.has(entry.token)) tokenFirstTimes.set(entry.token, []);
      tokenFirstTimes.get(entry.token).push(t);
      tokenPresence.set(entry.token, (tokenPresence.get(entry.token) || 0) + 1);
    }
  }
  return { tokenFirstTimes, tokenPresence };
}

/** Earliest non-universal non-unit token in a signature. */
function leadTechToken(sig) {
  if (!Array.isArray(sig)) return null;
  for (const e of sig) {
    if (!e || typeof e.token !== "string") continue;
    const bare = bareNoun(e.token);
    if (UNIVERSAL_OPEN_BARE.has(bare)) continue;
    if (isUnitToken(e.token)) continue;
    return e.token;
  }
  return null;
}

/** First alternative absent from the cluster (≤ RARE threshold). */
function pickDiscriminator(leadTech, tokenPresence, gameCount) {
  if (!leadTech || gameCount <= 0) return null;
  const alternatives = TECH_ALTERNATIVES[leadTech];
  if (!alternatives) return null;
  for (const alt of alternatives) {
    const presence = (tokenPresence.get(alt) || 0) / gameCount;
    if (presence <= RARE_TOKEN_THRESHOLD) return alt;
  }
  return null;
}

/**
 * Up to two tokens for the "<Opening> into <Tech>" label. Skips
 * universal opens; prefers buildings (so we don't get "Stargate
 * into Phoenix"); falls back to units when ≤ 1 building exists.
 */
function pickOpeningTokens(sig) {
  if (!Array.isArray(sig) || sig.length === 0) return [];
  const nonUniversal = sig.filter(
    (s) =>
      s &&
      typeof s.token === "string" &&
      !UNIVERSAL_OPEN_BARE.has(bareNoun(s.token)),
  );
  if (nonUniversal.length === 0) return sig.slice(0, 2);
  const buildingsOnly = nonUniversal.filter((s) => !isUnitToken(s.token));
  if (buildingsOnly.length >= 2) return buildingsOnly.slice(0, 2);
  return nonUniversal.slice(0, 2);
}

function computeSelfMatchRate(rules, clusterGames) {
  if (!Array.isArray(clusterGames) || clusterGames.length === 0) return 0;
  let passes = 0;
  for (const g of clusterGames) {
    const ev = g && Array.isArray(g.events) ? g.events : [];
    if (evaluateRules(rules, ev).pass) passes++;
  }
  return passes / clusterGames.length;
}

/**
 * Find the rule failing the most cluster games (probed alone) and
 * either widen its time_lt to cover the worst case or drop it.
 * Mutates `rules` in place; returns true iff changed.
 */
function relaxOnce(rules, clusterGames, tokenFirstTimes) {
  if (rules.length === 0) return false;
  const failByRule = new Array(rules.length).fill(0);
  for (const g of clusterGames) {
    const ev = g && Array.isArray(g.events) ? g.events : [];
    for (let ri = 0; ri < rules.length; ri++) {
      if (!evaluateRules([rules[ri]], ev).pass) failByRule[ri]++;
    }
  }
  let worstIdx = -1;
  let worstCount = 0;
  for (let i = 0; i < failByRule.length; i++) {
    if (failByRule[i] > worstCount) {
      worstIdx = i;
      worstCount = failByRule[i];
    }
  }
  if (worstIdx === -1) return false;
  const r = rules[worstIdx];
  if (r.type === "before") {
    const times = tokenFirstTimes.get(r.name) || [];
    let maxT = 0;
    for (const t of times) if (t > maxT) maxT = t;
    const widened = clampTimeLt(maxT + 15);
    if (widened > r.time_lt && widened <= 1800) {
      rules[worstIdx] = { ...r, time_lt: widened };
      return true;
    }
    rules.splice(worstIdx, 1);
    return true;
  }
  // not_before — widening doesn't help; drop it.
  rules.splice(worstIdx, 1);
  return true;
}

/**
 * Cluster-wide tokens shared by ≥ 80% of games become `before` rules
 * (time_lt = p90, rounded up to 15s, clamped 1..1800). ONE
 * `not_before` rule is prepended for the most discriminating absent
 * alternative tech. Total capped at MAX_DERIVED_RULES. Self-check +
 * up to MAX_RELAX_PASSES relaxations; returns null when post-relax
 * selfMatchRate < MIN_SELF_MATCH_RATE.
 *
 * @param {{representativeSignature?: Array<{token:string,t:number,count:number}>}} cluster
 * @param {ReadonlyArray<{events?: any[]}>} clusterGames
 * @returns {{rules: object[], selfMatchRate: number} | null}
 */
function deriveRules(cluster, clusterGames) {
  if (!cluster || !Array.isArray(clusterGames) || clusterGames.length === 0) {
    return null;
  }
  const n = clusterGames.length;
  const { tokenFirstTimes, tokenPresence } = indexCluster(clusterGames);

  const shared = [];
  for (const [tok, count] of tokenPresence) {
    if (count / n < SHARED_TOKEN_THRESHOLD) continue;
    const times = tokenFirstTimes.get(tok) || [];
    shared.push({
      token: tok,
      p50: percentile(times, 0.5),
      p90: percentile(times, 0.9),
    });
  }
  // Most-discriminating first: deepest tech (largest p50) leads.
  shared.sort((a, b) => {
    if (b.p50 !== a.p50) return b.p50 - a.p50;
    if (a.token < b.token) return -1;
    if (a.token > b.token) return 1;
    return 0;
  });

  const rules = [];
  const sig = cluster.representativeSignature || [];
  const discriminator = pickDiscriminator(leadTechToken(sig), tokenPresence, n);
  if (discriminator) {
    rules.push({
      type: "not_before",
      name: discriminator,
      time_lt: NOT_BEFORE_DEFAULT_SEC,
    });
  }
  for (const s of shared) {
    if (rules.length >= MAX_DERIVED_RULES) break;
    rules.push({
      type: "before",
      name: s.token,
      time_lt: clampTimeLt(s.p90),
    });
  }

  let rate = computeSelfMatchRate(rules, clusterGames);
  let attempts = 0;
  while (rate < 1.0 && attempts < MAX_RELAX_PASSES && rules.length > 0) {
    if (!relaxOnce(rules, clusterGames, tokenFirstTimes)) break;
    rate = computeSelfMatchRate(rules, clusterGames);
    attempts++;
  }

  if (rate < MIN_SELF_MATCH_RATE) return null;
  return { rules, selfMatchRate: rate };
}

/**
 * Compose "<Matchup> - <Opening> into <Tech>" from the medoid's
 * first 1–2 tech tokens (buildings preferred), with "(Fast)" when
 * the lead tech's p50 is below the per-tech FAST threshold. Slug =
 * kebab(name) + 6-char FNV-1a hash of `${matchup}|${signatureKey}`.
 *
 * @param {string} matchup
 * @param {{representativeSignature?: Array<{token:string,t:number,count:number}>}} cluster
 * @param {ReadonlyArray<{events?: any[]}>} clusterGames
 * @returns {{name: string, slug: string} | null}
 */
function deriveName(matchup, cluster, clusterGames) {
  if (!cluster) return null;
  const mu = typeof matchup === "string" && matchup.length > 0 ? matchup : "Build";
  const sig = cluster.representativeSignature || [];
  const opening = pickOpeningTokens(sig);

  let name = `${mu} - `;
  if (opening.length === 0) {
    name += "Macro Transition";
  } else {
    name += displayNoun(opening[0].token);
    if (
      opening.length > 1 &&
      bareNoun(opening[1].token) !== bareNoun(opening[0].token)
    ) {
      name += ` into ${displayNoun(opening[1].token)}`;
    }
  }

  const leadToken = opening.length > 0 ? opening[0].token : null;
  if (leadToken && FAST_THRESHOLDS[leadToken] !== undefined) {
    const times = [];
    for (const g of clusterGames || []) {
      const s = extractSignature((g && g.events) || []);
      const e = s.find((x) => x.token === leadToken);
      if (e) times.push(e.t);
    }
    if (
      times.length > 0 &&
      percentile(times, 0.5) < FAST_THRESHOLDS[leadToken]
    ) {
      name += " (Fast)";
    }
  }

  const sigKey = sig.map((e) => e.token).join(">");
  const hash = shortHash(`${mu}|${sigKey}`);
  const slug = `${kebabCase(name)}-${hash}`;

  return { name, slug };
}

module.exports = {
  deriveRules, deriveName, DISPLAY_NOUN, FAST_THRESHOLDS, TECH_ALTERNATIVES,
  UNIVERSAL_OPEN_BARE, MIN_SELF_MATCH_RATE, MAX_DERIVED_RULES,
  SHARED_TOKEN_THRESHOLD, RARE_TOKEN_THRESHOLD, NOT_BEFORE_DEFAULT_SEC,
};
