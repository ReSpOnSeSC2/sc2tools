"use strict";

const { COLLECTIONS } = require("../config/constants");
const {
  GUIDE_ARMY_CHECKPOINTS_SEC,
  GUIDE_ARMY_TOLERANCE_SEC,
  GUIDE_ARMY_TOP_UNITS,
} = require("../config/guides");
const { GUIDE_MILESTONES } = require("../config/guideMilestones");
const { stampVersion } = require("../db/schemaVersioning");
const { guideUserHash, guideGameHash } = require("../util/guideHash");
const {
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_ERA_RULE,
  dateMs,
  eraForGame,
} = require("../util/patchEra");
const { parseBuildLogLines } = require("./perGameCompute");
const {
  MAX_UNIT_KEYS_PER_TICK_SIDE,
  WORKER_NAMES,
  canonicalizeName,
} = require("./scouting/compositionAt");
const {
  INELIGIBLE,
  guideIneligibilityReason,
  leagueBandOf,
  matchupOf,
  mmrBandOf,
} = require("./guideRules");

/**
 * guide_samples — the per-game inputs of the public build guides that the
 * slim ``games`` row cannot answer: community milestone timings (from the
 * build log) and army snapshots at 6/8/10 minutes (from
 * ``macroBreakdown.unit_timeline``). Both heavy sources live only in
 * ``game_details``, which the nightly aggregate must never scan, so ingest
 * distils each eligible game into one compact row here.
 *
 * Privacy: rows carry no userId, gameId, names, toon handles or pulse ids.
 * They are keyed by ``userHash`` / ``gameHash`` (util/guideHash.js, HMACs
 * under the server pepper) — enough for the per-user cap, idempotent
 * re-uploads and GDPR deletion, useless for re-identification without the
 * pepper.
 *
 * Ingest contract (routes/games.js): ``capture`` does a bounded synchronous
 * extraction (3-5 ms median for a 5000-line log; see guideSamples.test.js) and then
 * a fire-and-forget upsert of the compact sample. It never throws, never
 * rejects, never retains the heavy ``game`` object, and never adds awaited
 * work to the single-lane ingest loop. At most MAX_PENDING_WRITES upserts
 * are in flight; beyond that samples are dropped and counted — the backfill
 * job can recover them. ``this.counters`` feeds /v1/metrics.
 *
 * Relabels: a re-upload whose agent label is no longer a guide build (a
 * reclassified game on Full Resync), or that ingest's custom-build tagging
 * relabelled (routes/games.js passes the tag's ``_customBuildSlug`` in),
 * removes the sample kept under the old label — the slim row now carries
 * the new one, so the old sample would feed a guide the game no longer
 * belongs to. The backfill does the same for games a bulk reclassification
 * relabelled.
 *
 * Kill switch: SC2TOOLS_GUIDE_SAMPLES_DISABLED=1 turns capture and sample
 * writes off (reads and GDPR deletes still work).
 *
 * Era rule: every write stamps ``eraRule: PATCH_ERA_RULE`` next to the
 * stored ``era`` (util/patchEra.js). Readers count only stamped rows;
 * ``relabelEraRule`` converts rows stored under rule 1 (see there).
 */

/** In-flight upsert cap; beyond it samples are dropped (and counted). */
const MAX_PENDING_WRITES = 64;
/** Validation caps buildLog / unit_timeline at 5000; rows read back by the backfill are re-bounded here. */
const MAX_BUILD_LOG_LINES = 5000;
const MAX_TIMELINE_ENTRIES = 5000;
/** Same bounds as validation/gameRecord.js. */
const MAX_GAME_SEC = 86400;
const MAP_MAX_CHARS = 200;
/** GDPR ranged wipes delete in chunks so one ``$in`` stays small. */
const DELETE_CHUNK = 1000;
const RESULTS = Object.freeze(["Victory", "Defeat", "Tie"]);
const DAY_MS = 86_400_000;
/** @type {ReadonlySet<string>} Skip reasons of a re-upload that make any stored sample stale. */
const RELABEL_REASONS = new Set([INELIGIBLE.NOT_GUIDE_BUILD, INELIGIBLE.CUSTOM_BUILD]);
/** Unit names become Mongo field keys: plain identifiers only. */
const SAFE_UNIT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** Timeline tokens that are not army before canonicalisation (it would fold AdeptPhaseShift → Adept, DisruptorPhased → Disruptor). */
const RAW_NON_ARMY = new Set(["AdeptPhaseShift", "DisruptorPhased", "KD8Charge", "ForceField", "OracleStasisTrap"]);
/** Canonical non-army names: workers, supply, spawned/summoned and cast "units". */
const NON_ARMY = new Set([
  ...WORKER_NAMES, "Overlord", "Larva", "Egg", "Broodling", "BroodlingEscort", "Locust",
  "Interceptor", "AutoTurret", "PointDefenseDrone", "InfestedTerran", "CreepTumor", "CreepTumorQueen",
]);
const NON_ARMY_PREFIX_RE = /^(Beacon|Changeling)/;

/** Skip reason codes beyond guideRules' eligibility codes. */
const SKIP = Object.freeze({
  DISABLED: "disabled",
  INVALID_INPUT: "invalid_input",
  NO_ERA: "no_era",
  NO_BUILD_LOG: "no_build_log",
  BAD_RESULT: "bad_result",
  BAD_MAP: "bad_map",
});

/**
 * @typedef {object} GuideSampleFields
 * @property {string} buildKey             exact catalog build name
 * @property {string} matchup              "PvZ" form
 * @property {"after"|"before"} era
 * @property {number|null} leagueBand      opponent league 0..6
 * @property {number|null} mmrBand         opponent MMR band floor
 * @property {"Victory"|"Defeat"|"Tie"} result
 * @property {string} map
 * @property {number|null} durationSec
 * @property {Date|null} playedOn         UTC day the game was played (midnight; day
 *   precision only, so no row carries the game's timestamp) — the per-user cap's order
 * @property {Record<string, number>} milestones  milestone key → recorded seconds
 * @property {Record<string, Record<string, number>>} army checkpoint sec → {Unit: count}
 */

/** @typedef {{ skip: string }} GuideSampleSkip */

/**
 * Per race: lowercase wire name → indices into that race's milestone list.
 * @type {Record<string, Map<string, number[]>>}
 */
const MILESTONE_INDEX = Object.fromEntries(
  Object.entries(GUIDE_MILESTONES).map(([race, list]) => {
    /** @type {Map<string, number[]>} */
    const byName = new Map();
    list.forEach((m, i) => {
      for (const name of m.names) {
        const key = name.toLowerCase();
        byName.set(key, [...(byName.get(key) || []), i]);
      }
    });
    return [race, byName];
  }),
);

/**
 * Parsed build-log events (shared parser, recorded times), bounded.
 *
 * @param {unknown} buildLog
 * @returns {ReturnType<typeof parseBuildLogLines>}
 */
function parseLogEvents(buildLog) {
  if (!Array.isArray(buildLog)) return [];
  const lines = buildLog.length > MAX_BUILD_LOG_LINES ? buildLog.slice(0, MAX_BUILD_LOG_LINES) : buildLog;
  return parseBuildLogLines(lines, null);
}

/** @param {unknown} t @returns {t is number} */
function isGameSecond(t) {
  return typeof t === "number" && Number.isSafeInteger(t) && t >= 0 && t <= MAX_GAME_SEC;
}

/**
 * Count one logged line against the milestones it names; record every
 * milestone whose occurrence it completes.
 *
 * @param {ReadonlyArray<number>} hits milestone indices for the line's name
 * @param {number} time recorded seconds
 * @param {ReadonlyArray<import('../config/guideMilestones').GuideMilestone>} list
 * @param {number[]} seen per-milestone line counts (mutated)
 * @param {Record<string, number>} out milestone key → seconds (mutated)
 * @returns {number} milestones completed by this line
 */
function recordHits(hits, time, list, seen, out) {
  let completed = 0;
  for (const i of hits) {
    seen[i] += 1;
    if (seen[i] !== list[i].occurrence) continue;
    out[list[i].key] = time;
    completed += 1;
  }
  return completed;
}

/**
 * Milestone times from the build log via the shared parser
 * (``parseBuildLogLines``, recorded times). Occurrence N = the Nth logged
 * line of any of the milestone's names (case-insensitive).
 *
 * @param {unknown} buildLog
 * @param {string} raceLetterValue "P" | "T" | "Z"
 * @returns {Record<string, number>|null} null when no line parses
 */
function extractMilestones(buildLog, raceLetterValue) {
  const events = parseLogEvents(buildLog);
  if (events.length === 0) return null;
  const list = GUIDE_MILESTONES[/** @type {"P"|"T"|"Z"} */ (raceLetterValue)];
  const index = MILESTONE_INDEX[raceLetterValue];
  const seen = new Array(list.length).fill(0);
  /** @type {Record<string, number>} */
  const out = {};
  let remaining = list.length;
  for (const ev of events) {
    const hits = index.get(ev.name.toLowerCase());
    if (hits && isGameSecond(ev.time)) remaining -= recordHits(hits, ev.time, list, seen, out);
    if (remaining === 0) break;
  }
  return out;
}

/** @param {unknown} entry @returns {number|null} finite sample time */
function timelineTime(entry) {
  const t = entry && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry).time : undefined;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/**
 * For each checkpoint: the timeline entry with the smallest distance
 * ≤ tolerance (ties → the earlier sample, so a snapshot never reads the
 * future). Checkpoints the game never reached are omitted.
 *
 * @param {ReadonlyArray<unknown>} timeline
 * @param {number|null} durationSec
 * @returns {Map<number, Record<string, unknown>>} checkpoint → entry
 */
function nearestEntries(timeline, durationSec) {
  const reachable = GUIDE_ARMY_CHECKPOINTS_SEC.filter((cp) => durationSec === null || cp <= durationSec);
  /** @type {Map<number, { t: number, d: number, entry: Record<string, unknown> }>} */
  const best = new Map();
  const n = Math.min(timeline.length, MAX_TIMELINE_ENTRIES);
  for (let i = 0; i < n; i += 1) {
    const t = timelineTime(timeline[i]);
    if (t === null) continue;
    for (const cp of reachable) {
      const d = Math.abs(t - cp);
      const prev = best.get(cp);
      const closer = !prev || d < prev.d || (d === prev.d && t < prev.t);
      if (d <= GUIDE_ARMY_TOLERANCE_SEC && closer) {
        best.set(cp, { t, d, entry: /** @type {Record<string, unknown>} */ (timeline[i]) });
      }
    }
  }
  return new Map([...best].map(([cp, hit]) => [cp, hit.entry]));
}

/**
 * Canonical army-unit name for a timeline token, or null for non-army.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function armyUnitName(raw) {
  if (RAW_NON_ARMY.has(raw) || NON_ARMY_PREFIX_RE.test(raw)) return null;
  const name = canonicalizeName(raw);
  if (!name || NON_ARMY.has(name) || NON_ARMY_PREFIX_RE.test(name)) return null;
  return SAFE_UNIT_NAME_RE.test(name) ? name : null;
}

/**
 * @param {unknown} v a unit_timeline count
 * @returns {number} the whole unit count, 0 when not a finite positive number
 */
function wholeCount(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * Fold one ``my`` side onto canonical army names (bounded key scan).
 *
 * @param {unknown} side
 * @returns {Map<string, number>}
 */
function foldArmySide(side) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!side || typeof side !== "object" || Array.isArray(side)) return counts;
  const map = /** @type {Record<string, unknown>} */ (side);
  const keys = Object.keys(map).slice(0, MAX_UNIT_KEYS_PER_TICK_SIDE);
  for (const raw of keys) {
    const count = wholeCount(map[raw]);
    const name = count > 0 ? armyUnitName(raw) : null;
    if (name) counts.set(name, (counts.get(name) || 0) + count);
  }
  return counts;
}

/**
 * The top army units of one ``my`` side (count desc, then name).
 *
 * @param {unknown} side
 * @returns {Record<string, number>}
 */
function topArmyUnits(side) {
  const top = [...foldArmySide(side)]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, GUIDE_ARMY_TOP_UNITS);
  return Object.fromEntries(top);
}

/**
 * Army snapshots at the guide checkpoints. A present checkpoint with no
 * army units is ``{}`` (a real zero); a missing checkpoint is omitted.
 *
 * @param {unknown} macroBreakdown
 * @param {number|null} durationSec
 * @returns {Record<string, Record<string, number>>}
 */
function extractArmy(macroBreakdown, durationSec) {
  /** @type {Record<string, Record<string, number>>} */
  const army = {};
  const mb = /** @type {Record<string, unknown>|null} */ (
    macroBreakdown && typeof macroBreakdown === "object" ? macroBreakdown : null
  );
  const timeline = mb ? mb.unit_timeline : undefined;
  if (!Array.isArray(timeline)) return army;
  for (const [cp, entry] of nearestEntries(timeline, durationSec)) {
    army[String(cp)] = topArmyUnits(entry.my);
  }
  return army;
}

/**
 * The UTC day a game was played. Day precision on purpose: ordering the
 * per-user cap needs no more, and a sample must not carry the game's
 * timestamp (game ids embed it).
 *
 * Example: `playedOnOf("2026-07-01T12:00:00Z")` → `2026-07-01T00:00:00.000Z`.
 *
 * @param {unknown} date ISO string (ingest) or Date (backfill)
 * @returns {Date|null}
 */
function playedOnOf(date) {
  const ms = dateMs(date);
  return ms === null ? null : new Date(Math.floor(ms / DAY_MS) * DAY_MS);
}

/** @param {unknown} v @returns {number|null} */
function durationOf(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_GAME_SEC ? v : null;
}

/**
 * Distil one game into guide sample fields — pure; the ingest hook and the
 * backfill job share it. Works on the ingest payload (ISO ``date``) and on
 * a slim games row merged with its details (Date ``date``).
 *
 * Example: `extractSample(game)` → `{ buildKey, matchup, era, …, milestones, army }`
 * or `{ skip: "not_ladder" }`.
 *
 * @param {unknown} raw
 * @returns {GuideSampleFields | GuideSampleSkip}
 */
function extractSample(raw) {
  const reason = guideIneligibilityReason(raw);
  if (reason) return { skip: reason };
  const game = /** @type {Record<string, any>} */ (raw);
  const era = eraForGame(game);
  if (!era) return { skip: SKIP.NO_ERA };
  if (!RESULTS.includes(game.result)) return { skip: SKIP.BAD_RESULT };
  if (typeof game.map !== "string" || game.map.length === 0) return { skip: SKIP.BAD_MAP };
  const matchup = /** @type {string} */ (matchupOf(game.myRace, game.opponent.race));
  const milestones = extractMilestones(game.buildLog, matchup[0]);
  if (!milestones) return { skip: SKIP.NO_BUILD_LOG };
  const durationSec = durationOf(game.durationSec);
  return {
    buildKey: game.myBuild,
    matchup,
    era,
    leagueBand: leagueBandOf(game.opponent),
    mmrBand: mmrBandOf(game.opponent),
    result: game.result,
    map: game.map.slice(0, MAP_MAX_CHARS),
    durationSec,
    playedOn: playedOnOf(game.date),
    milestones,
    army: extractArmy(game.macroBreakdown, durationSec),
  };
}

/**
 * @param {unknown} userId
 * @param {unknown} game
 * @returns {string|null} the game's id when both identifiers are usable
 */
function captureGameId(userId, game) {
  if (typeof userId !== "string" || !userId || !game || typeof game !== "object") return null;
  const gameId = /** @type {Record<string, unknown>} */ (game).gameId;
  return typeof gameId === "string" && gameId ? gameId : null;
}

/**
 * True for a re-upload whose explicit ``myBuild`` is no longer a guide
 * build, or that the ingest's custom-build tagging relabelled to a saved
 * "you" definition: any sample stored for the game carries a stale label.
 * Other skip reasons never remove a sample — a sparser re-upload payload
 * must not erase what an earlier, complete upload captured.
 *
 * @param {unknown} game
 * @param {string} reason extractSample's skip code
 * @param {{ created?: boolean } | undefined} opts
 * @returns {boolean}
 */
function isRelabelledReupload(game, reason, opts) {
  if (!opts || opts.created !== false || !RELABEL_REASONS.has(reason)) return false;
  return typeof (/** @type {Record<string, unknown>} */ (game)).myBuild === "string";
}

class GuideSamplesService {
  /**
   * @param {{ guideSamples: import('mongodb').Collection }} db DbContext (only ``guideSamples`` is used)
   * @param {{
   *   pepper: Buffer,
   *   logger?: import('pino').Logger | null,
   *   disabled?: boolean,
   *   maxPending?: number,
   *   now?: () => number,
   * }} opts ``disabled`` defaults to SC2TOOLS_GUIDE_SAMPLES_DISABLED=1
   */
  constructor(db, opts) {
    if (!opts || !opts.pepper) throw new TypeError("GuideSamplesService: pepper required");
    this.coll = db.guideSamples;
    this.pepper = opts.pepper;
    this.logger = opts.logger || null;
    this.disabled = opts.disabled ?? process.env.SC2TOOLS_GUIDE_SAMPLES_DISABLED === "1";
    this.maxPending = opts.maxPending ?? MAX_PENDING_WRITES;
    this.now = opts.now || Date.now;
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
    /** Per-process tallies, exposed as sc2tools_guide_samples_* gauges. */
    this.counters = { captured: 0, skipped: 0, failed: 0, dropped: 0 };
  }

  /**
   * Ingest hook: extract synchronously, then write in the background.
   * Never throws; the returned value is always undefined.
   *
   * @param {string} userId
   * @param {unknown} game validated ingest payload (heavy fields still on it)
   * @param {{ created?: boolean }} [opts] ``created: false`` marks a
   *   re-upload, whose relabel to a non-guide build removes the stale sample
   */
  capture(userId, game, opts) {
    if (this.disabled) return;
    try {
      const gameId = captureGameId(userId, game);
      if (!gameId) {
        this._skipped(SKIP.INVALID_INPUT);
        return;
      }
      const sample = extractSample(game);
      if ("skip" in sample) {
        this._skipped(sample.skip);
        if (isRelabelledReupload(game, sample.skip, opts)) {
          const key = this._key(userId, gameId);
          this._enqueue(() => this.coll.deleteOne(key), "stale_delete_failed");
        }
        return;
      }
      // Only the hashed key + the compact sample reach the background
      // closure; ``game`` and ``userId`` are not retained by a pending write.
      const key = this._key(userId, gameId);
      this._enqueue(() => this._upsert(key.userHash, key.gameHash, sample), "write_failed", () => {
        this.counters.captured += 1;
      });
    } catch (err) {
      this._failed(err, "extract_failed");
    }
  }

  /**
   * Awaited write for the backfill job (bypasses the pending cap).
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {GuideSampleFields} sample from ``extractSample``
   * @returns {Promise<boolean>} false when writes are disabled
   */
  async writeSample(userId, gameId, sample) {
    if (this.disabled) return false;
    const key = this._key(userId, gameId);
    await this._upsert(key.userHash, key.gameHash, sample);
    this.counters.captured += 1;
    return true;
  }

  /**
   * Delete one game's sample, awaited (the backfill's cleanup of samples
   * whose game is gone or no longer a guide game).
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<number>} deleted count (0 or 1)
   */
  async removeSample(userId, gameId) {
    const res = await this.coll.deleteOne(this._key(userId, gameId));
    return res.deletedCount || 0;
  }

  /**
   * Resolve once no capture write is in flight, including writes started
   * while waiting (tests, shutdown — where ingest has stopped).
   */
  async drain() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * Settle the capture writes already in flight — one snapshot, so the
   * wait is bounded by ``maxPending`` writes however busy ingest is. The
   * GDPR deletes use this rather than ``drain``: other users' later
   * captures must not hold an erasure (and its mutation fence) open.
   */
  async _settleInFlight() {
    await Promise.all([...this.pending]);
  }

  /**
   * GDPR account deletion: every sample of the user.
   *
   * @param {string} userId
   * @returns {Promise<number>} deleted count
   */
  async deleteForUser(userId) {
    await this._settleInFlight();
    const res = await this.coll.deleteMany({ userHash: this.userHash(userId) });
    return res.deletedCount || 0;
  }

  /**
   * GDPR ranged history wipe: the samples of exactly these games.
   *
   * @param {string} userId
   * @param {ReadonlyArray<string>} gameIds
   * @returns {Promise<number>} deleted count
   */
  async deleteForGames(userId, gameIds) {
    await this._settleInFlight();
    const userHash = this.userHash(userId);
    const hashes = gameIds
      .filter((id) => typeof id === "string" && id)
      .map((id) => guideGameHash(this.pepper, userId, id));
    let deleted = 0;
    for (let i = 0; i < hashes.length; i += DELETE_CHUNK) {
      const res = await this.coll.deleteMany({ userHash, gameHash: { $in: hashes.slice(i, i + DELETE_CHUNK) } });
      deleted += res.deletedCount || 0;
    }
    return deleted;
  }

  /**
   * The caller's pseudonymous key (the /me comparison endpoint queries by it).
   *
   * @param {string} userId
   * @returns {string}
   */
  userHash(userId) {
    return guideUserHash(this.pepper, userId);
  }

  /**
   * The unique ``{userHash, gameHash}`` key of one game's sample.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {{ userHash: string, gameHash: string }}
   */
  _key(userId, gameId) {
    return { userHash: this.userHash(userId), gameHash: guideGameHash(this.pepper, userId, gameId) };
  }

  /**
   * @param {string} userHash
   * @param {string} gameHash
   * @param {GuideSampleFields} sample
   */
  async _upsert(userHash, gameHash, sample) {
    const now = new Date(this.now());
    await this.coll.updateOne(
      { userHash, gameHash },
      {
        $set: { ...sample, eraRule: PATCH_ERA_RULE, updatedAt: now },
        $setOnInsert: stampVersion({ createdAt: now }, COLLECTIONS.GUIDE_SAMPLES),
      },
      { upsert: true },
    );
  }

  /**
   * Start one background write unless the pending cap is reached (then the
   * write is never started: dropped and counted). The tracked promise
   * never rejects.
   *
   * @param {() => Promise<unknown>} start
   * @param {string} failReason reason code logged on failure
   * @param {() => void} [onSuccess]
   */
  _enqueue(start, failReason, onSuccess) {
    if (this.pending.size >= this.maxPending) {
      this.counters.dropped += 1;
      this._log("debug", { reason: "backpressure" }, "guide_sample_dropped");
      return;
    }
    /** @type {Promise<void>} */
    const tracked = start().then(
      () => { if (onSuccess) onSuccess(); },
      (err) => { this._failed(err, failReason); },
    );
    this.pending.add(tracked);
    void tracked.then(() => { this.pending.delete(tracked); });
  }

  /** @param {string} reason */
  _skipped(reason) {
    this.counters.skipped += 1;
    this._log("debug", { reason }, "guide_sample_skipped");
  }

  /** @param {unknown} err @param {string} reason */
  _failed(err, reason) {
    this.counters.failed += 1;
    const e = /** @type {{ code?: unknown, codeName?: unknown }} */ (err || {});
    // Reason + driver error code only: messages can echo document values.
    this._log("warn", { reason, code: e.code ?? null, codeName: e.codeName ?? null }, "guide_sample_failed");
  }

  /**
   * Logging must not be able to break the never-throws contract.
   *
   * @param {"debug" | "warn"} level
   * @param {Record<string, unknown>} fields reason codes only — never PII
   * @param {string} msg
   */
  _log(level, fields, msg) {
    try {
      this.logger?.[level](fields, msg);
    } catch {
      // A broken logger is not a capture failure.
    }
  }
}

/**
 * Relabel samples stored under era rule 1, idempotently. Rule 1 had
 * "after" = patch 5.0.16 and later and "before" = earlier games; rule 2
 * has "after" = the 12-worker game and "before" = the 8-worker patch
 * 5.0.16. A sample keeps no game version, so the labels are swapped: exact
 * for every rule-1 row captured before 5.0.17 went live, which is all of
 * them when this ships with the rule. The admin samples backfill
 * re-derives every era from the games themselves if in doubt.
 *
 * Example: `await relabelEraRule(db.guideSamples)` → 1234 (rows relabelled).
 *
 * @param {import('mongodb').Collection} coll guide_samples
 * @returns {Promise<number>} rows relabelled
 */
async function relabelEraRule(coll) {
  const res = await coll.updateMany(
    { eraRule: { $ne: PATCH_ERA_RULE }, era: { $in: [PATCH_ERA_AFTER, PATCH_ERA_BEFORE] } },
    [
      {
        $set: {
          era: { $cond: [{ $eq: ["$era", PATCH_ERA_AFTER] }, PATCH_ERA_BEFORE, PATCH_ERA_AFTER] },
          eraRule: PATCH_ERA_RULE,
        },
      },
    ],
  );
  return res.modifiedCount;
}

module.exports = {
  GuideSamplesService,
  extractSample,
  relabelEraRule,
  MAX_PENDING_WRITES,
  SKIP,
};
