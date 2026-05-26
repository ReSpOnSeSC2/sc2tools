"use strict";

/**
 * autoClassify/signature — Opening signature extraction for the
 * auto-classifier discovery engine.
 *
 * An "opening signature" is a deduped, time-ordered list of the
 * non-economy tech events a player committed to before some horizon
 * (default 8:00). It is the primitive the discovery engine groups
 * on: games with similar signatures opened the same way.
 *
 * Reuses `eventToken` and `UNIT_TECH_PREREQUISITES` from the rule
 * evaluator so this stays in lock-step with /preview-matches and
 * /reclassify — there must be exactly ONE canonical normalisation
 * of an event in the cloud, and the auto-classifier MUST share it
 * (otherwise a discovered build would tag games the rule engine
 * wouldn't tag for the same rules, or vice-versa).
 *
 * Pure: no I/O, no Mongo, deterministic in the event list.
 */

const {
  eventToken,
  UNIT_TECH_PREREQUISITES,
} = require("../buildRulesEvaluator");

/**
 * Bare-noun tokens (post-verb-prefix) that DO NOT discriminate
 * openings. Every macro game starts with these in roughly the same
 * order, so including them in the signature dilutes the signal of
 * the actual tech path the player committed to.
 *
 * Keyed on the BARE noun so e.g. dropping "Pylon" drops the canonical
 * token "BuildPylon".
 *
 * The set matches the discovery-engine spec exactly: workers, supply,
 * starting town halls, and gas geysers. Tech-bearing base upgrades
 * (Lair / Hive / OrbitalCommand / PlanetaryFortress) are NOT
 * excluded — they signal investment level / tech commitment.
 */
const ECONOMY_NOISE_BARE = new Set([
  // Starting town halls
  "Nexus",
  "CommandCenter",
  "Hatchery",
  // Supply
  "Pylon",
  "SupplyDepot",
  "Overlord",
  // Workers
  "Probe",
  "SCV",
  "Drone",
  // Gas geysers
  "Assimilator",
  "Refinery",
  "Extractor",
]);

const VERB_PREFIX_RE = /^(Build|Train|Research|Morph)(?=[A-Z])/;

/**
 * Default opening horizon, in seconds. 8:00 captures the tech path
 * the player committed to (Stargate vs Robo vs Twilight, follow-up
 * tech bay, first composition) before mid-game divergence kicks in.
 */
const DEFAULT_HORIZON_SEC = 480;

/**
 * Strip a verb prefix (Build / Train / Research / Morph) from a
 * canonical token to recover the bare noun.
 *
 * @param {string} token
 * @returns {string}
 */
function bareNoun(token) {
  if (typeof token !== "string") return "";
  return token.replace(VERB_PREFIX_RE, "");
}

/**
 * Index the earliest `Build<X>` time per structure across `events`.
 * Used by the hallucination filter to ask "was this structure ever
 * started before this unit appeared?". Mirrors the helper inside
 * buildRulesEvaluator so the auto-classifier and the rule engine
 * agree on what counts as a "real" unit event.
 *
 * @param {ReadonlyArray<ParsedEvent>} events
 * @returns {Map<string, number>}
 */
function earliestBuildTimes(events) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t)) continue;
    const tok = eventToken(ev);
    if (typeof tok !== "string") continue;
    if (!tok.startsWith("Build")) continue;
    const bare = tok.slice("Build".length);
    if (!bare) continue;
    const cur = out.get(bare);
    if (cur === undefined || t < cur) out.set(bare, t);
  }
  return out;
}

/**
 * Test whether a unit event is "real" given the structures present
 * so far. Mirrors the same predicate buildRulesEvaluator uses on
 * its own rule evaluation path.
 *
 * @param {ParsedEvent} ev
 * @param {Map<string, number>} earliestBuilds
 * @returns {boolean}
 */
function unitPrereqMet(ev, earliestBuilds) {
  const tok = eventToken(ev);
  if (typeof tok !== "string") return true;
  const bare = bareNoun(tok);
  const alternatives = UNIT_TECH_PREREQUISITES[bare];
  if (!alternatives) return true;
  const t = Number(ev.time);
  if (!Number.isFinite(t)) return true;
  return alternatives.some((reqSet) =>
    reqSet.every((req) => {
      const built = earliestBuilds.get(req);
      return built !== undefined && built <= t;
    }),
  );
}

/**
 * @typedef {{time:number, name:string, race?:string, category?:string,
 *            is_building?:boolean}} ParsedEvent
 *
 * @typedef {{token:string, t:number, count:number}} SignatureEntry
 *
 * @typedef {ReadonlyArray<SignatureEntry>} Signature
 */

/**
 * Extract the opening signature from a parsed event list.
 *
 * For every event with `0 <= time < horizonSec`:
 *   1. canonicalise via `eventToken` (the same writer the rule
 *      engine uses);
 *   2. drop economy tokens — workers, supply, starting town halls,
 *      gas geysers (see {@link ECONOMY_NOISE_BARE});
 *   3. drop hallucinated unit events whose tech prerequisite isn't
 *      satisfied at the event's own time (same {@link
 *      UNIT_TECH_PREREQUISITES} table the rule engine uses).
 *
 * Then collapse repeats of the same token to its first occurrence
 * (carrying a `count` of how many landed before the horizon). The
 * returned array is sorted by first-occurrence time, with token
 * name as the tiebreaker so the output is fully deterministic.
 *
 * The prerequisite index is built over the FULL event list — the
 * filter asks "was the structure ever started before this unit?"
 * (matching the rule evaluator). A Stargate at 7:00 still qualifies
 * a Phoenix at 7:30 even if the Stargate dies off-screen.
 *
 * @param {ReadonlyArray<ParsedEvent>} events
 * @param {{horizonSec?: number}} [opts]
 * @returns {SignatureEntry[]}
 */
function extractSignature(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const horizonRaw = opts ? Number(opts.horizonSec) : NaN;
  const horizonSec = Number.isFinite(horizonRaw) && horizonRaw > 0
    ? horizonRaw
    : DEFAULT_HORIZON_SEC;
  const earliestBuilds = earliestBuildTimes(events);

  /** @type {Map<string, {t:number, count:number}>} */
  const byToken = new Map();
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t) || t < 0) continue;
    if (t >= horizonSec) continue;
    const tok = eventToken(ev);
    if (typeof tok !== "string") continue;
    const bare = bareNoun(tok);
    if (!bare) continue;
    if (ECONOMY_NOISE_BARE.has(bare)) continue;
    if (
      Object.prototype.hasOwnProperty.call(UNIT_TECH_PREREQUISITES, bare) &&
      !unitPrereqMet(ev, earliestBuilds)
    ) {
      continue;
    }
    const cur = byToken.get(tok);
    if (cur === undefined) {
      byToken.set(tok, { t, count: 1 });
    } else {
      cur.count += 1;
      if (t < cur.t) cur.t = t;
    }
  }

  /** @type {SignatureEntry[]} */
  const arr = [];
  for (const [token, { t, count }] of byToken) {
    arr.push({ token, t, count });
  }
  arr.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.token < b.token) return -1;
    if (a.token > b.token) return 1;
    return 0;
  });
  return arr;
}

/**
 * Coarse bucket key for a signature — the first six tokens joined
 * by `">"`. Two signatures with the same key opened with the same
 * tech commitments in the same order; the discovery engine uses
 * this as a cheap pre-filter before computing pairwise distance
 * inside each bucket.
 *
 * Six tokens is enough to capture the meaningful early commitments
 * (e.g. `BuildGateway>BuildCyberneticsCore>BuildStargate>BuildPhoenix>BuildFleetBeacon>BuildTempest`)
 * without being so specific that two stylistically identical
 * openings end up in different buckets over a single deviant follow-up.
 *
 * @param {Signature} signature
 * @returns {string}
 */
function signatureKey(signature) {
  if (!Array.isArray(signature) || signature.length === 0) return "";
  const tokens = [];
  const limit = Math.min(6, signature.length);
  for (let i = 0; i < limit; i++) {
    const s = signature[i];
    if (s && typeof s.token === "string" && s.token.length > 0) {
      tokens.push(s.token);
    }
  }
  return tokens.join(">");
}

/**
 * Levenshtein edit distance between two arrays of tokens. Each
 * slot is an atomic symbol — one substitution per differing slot,
 * insertions / deletions for length mismatch. O(|a|·|b|) time, O(|b|)
 * space; safe for the ≤ ~20-token signatures we work with.
 *
 * @param {ReadonlyArray<string>} a
 * @param {ReadonlyArray<string>} b
 * @returns {number}
 */
function levenshteinArr(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Pairwise dissimilarity between two opening signatures, in [0, 1].
 *
 *     distance = 0.7 * lev_norm + 0.3 * timing_norm
 *
 * where
 *     lev_norm    = levenshtein(tokens_a, tokens_b) / max(|a|, |b|)
 *     timing_norm = mean( |t_a(tok) − t_b(tok)| ) ÷ horizonSec
 *                   over the set of tokens present in BOTH signatures
 *                   (0 when there is no overlap — the Levenshtein
 *                   term already saturates at 1.0 in that case, so
 *                   distance still reaches 0.7 for disjoint sequences)
 *
 * Weights chosen so that:
 *   • identical sequences with identical times → 0
 *   • same tokens, normal opening-timing wobble (~10–30 sec/token)
 *     stays well under 0.15
 *   • Stargate-first vs Robo-first (sharing only Gateway / Cyber
 *     as common early tech, ~6 substitutions over an ~8-token
 *     window) lands above 0.5
 *   • fully disjoint sequences saturate at 0.7 (≥ 0.5)
 *
 * Token order is the dominant signal — a Stargate-first opener is
 * structurally different from a Robo-first opener regardless of
 * exact timing. Timing is a fine-grained tiebreaker for openings
 * whose token order matches but which commit at different speeds.
 *
 * @param {Signature} a
 * @param {Signature} b
 * @param {{horizonSec?: number}} [opts]
 * @returns {number}
 */
function signatureDistance(a, b, opts = {}) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 1;
  if (a.length === 0 && b.length === 0) return 0;

  const horizonRaw = opts ? Number(opts.horizonSec) : NaN;
  const horizonSec = Number.isFinite(horizonRaw) && horizonRaw > 0
    ? horizonRaw
    : DEFAULT_HORIZON_SEC;

  const tokensA = a.map((x) =>
    x && typeof x.token === "string" ? x.token : "",
  );
  const tokensB = b.map((x) =>
    x && typeof x.token === "string" ? x.token : "",
  );
  const lev = levenshteinArr(tokensA, tokensB);
  const maxLen = Math.max(tokensA.length, tokensB.length);
  const levNorm = maxLen === 0 ? 0 : Math.min(1, lev / maxLen);

  /** @type {Map<string, number>} */
  const timesA = new Map();
  for (const e of a) {
    if (!e || typeof e.token !== "string") continue;
    const t = Number(e.t);
    if (!Number.isFinite(t)) continue;
    // First-seen wins; signatures are already deduped by token, so
    // this branch only matters if a caller hand-builds a malformed
    // signature.
    if (!timesA.has(e.token)) timesA.set(e.token, t);
  }
  let sharedCount = 0;
  let sharedDeltaSum = 0;
  for (const e of b) {
    if (!e || typeof e.token !== "string") continue;
    const tA = timesA.get(e.token);
    if (tA === undefined) continue;
    const tB = Number(e.t);
    if (!Number.isFinite(tB)) continue;
    sharedCount++;
    sharedDeltaSum += Math.abs(tA - tB);
  }
  const timingNorm =
    sharedCount === 0
      ? 0
      : Math.min(1, sharedDeltaSum / sharedCount / horizonSec);

  const dist = 0.7 * levNorm + 0.3 * timingNorm;
  if (dist < 0) return 0;
  if (dist > 1) return 1;
  return dist;
}

module.exports = {
  extractSignature,
  signatureKey,
  signatureDistance,
  ECONOMY_NOISE_BARE,
  DEFAULT_HORIZON_SEC,
};
