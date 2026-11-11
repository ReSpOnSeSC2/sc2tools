"use strict";

const crypto = require("crypto");
const { COLLECTIONS, INGEST_PROVENANCE } = require("../config/constants");
const { buildSecondsFor } = require("./buildDurations");
const { isKnownBuilding, isKnownUpgrade } = require("./knownBuildings");
const { stampVersion } = require("../db/schemaVersioning");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { CLASSIFIER_QUALITY_INDEXES } = require("../db/classifierQualityIndexes");
const catalog = require("../config/presetCatalog.json");

/**
 * ClassifierQualityService: what confirmed build check-ins say about the
 * replay detector's labels (docs/classifier-quality.md).
 *
 * A confirmed, applied check-in stores the label the player declared next to
 * the label the classifier detected, on both axes ("build" = the player's own
 * build, "opponent" = a corrected opponent strategy). ``recompute`` (the
 * nightly job) reads the check-ins confirmed in the last WINDOW_DAYS days and
 * writes one ``classifier_quality`` snapshot:
 *
 *   - pairs: per (axis, matchup, detected → declared) disagreement, its
 *     count, distinct users, per-engine split and correction provenance
 *     (pre-game plan, post-game check-in, website correction);
 *   - labels: per (axis, label) agreements, misses (declared, not detected)
 *     and mislabels (detected, not declared);
 *   - engines: check-ins and disagreements per detecting engine;
 *   - trust: per released preset label, "matches N of M player corrections"
 *     for /definitions.
 *
 * Guardrails: every published row needs K_FLOOR distinct users (smaller rows
 * are only counted in ``totals.suppressed*``), rows never carry a user or game
 * id, the scan is index-bounded by the window and ROW_LIMIT, and nothing here
 * edits a rule: rules stay human-edited in Build Studio and nothing auto-tunes.
 * Counts are disagreement volume from players who checked in, never accuracy.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;
const K_FLOOR = 3;
/** Newest check-ins read per axis; a busier window is flagged ``truncated``. */
const ROW_LIMIT = 100_000;
const SNAPSHOTS_KEPT = 7;
const PAIRS_KEPT = 1000;
const LABELS_KEPT = 1000;
const ENGINES_KEPT = 50;
const PAIR_ENGINES_KEPT = 20;
const ENGINE_VERSION_RE = new RegExp(INGEST_PROVENANCE.ENGINE_VERSION_PATTERN);
const UNLISTED_LABEL = "Other label";
const VIEW_LIMIT = 200;
const SAMPLE_LIMIT = 20;
/** Drill-down build orders stop at 6:00 of recorded game time. */
const SAMPLE_SECONDS = 360;
const SAMPLE_LINES_MAX = 150;
const SCAN_MAX_TIME_MS = 120_000;
const SAMPLE_MAX_TIME_MS = 15_000;
const CUSTOM_LABEL = "Custom build";
const NO_LABEL = "No label";
const LABEL_MAX = 200;
const MATCHUP_RE = /^(?:[PTZ]v[PTZ]|Unknown)$/;
const ORIGINS = Object.freeze(["pregame", "postgame", "web"]);

/** @typedef {"build"|"opponent"} Axis */
/** @type {Readonly<Record<Axis, {intent: string, index: string}>>} */
const AXES = Object.freeze({
  build: { intent: "buildIntent", index: CLASSIFIER_QUALITY_INDEXES.build },
  opponent: { intent: "buildIntent.opponent", index: CLASSIFIER_QUALITY_INDEXES.opponent },
});

/** @type {ReadonlyMap<string, any>} */
const CATALOG = new Map(catalog.definitions.map((/** @type {any} */ entry) => [entry.name, entry]));
/** 8-worker (5.0.16) era names fold into their released label. */
const CANONICAL = new Map([
  ...catalog.definitions.map((/** @type {any} */ entry) => /** @type {[string, string]} */ ([entry.name, entry.name])),
  ...catalog.definitions.filter((/** @type {any} */ entry) => typeof entry.eightWorkerName === "string")
    .map((/** @type {any} */ entry) => /** @type {[string, string]} */ ([entry.eightWorkerName, entry.name])),
]);

/**
 * @typedef {{
 *   axis: Axis, userId: string, matchup: string, engine: string,
 *   declared: string, detected: string, agree: boolean, origin: "pregame"|"postgame"|"web"|"other",
 *   confirmedAt: Date | null,
 * }} CheckIn
 */

class ClassifierQualityService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   gameDetails?: Pick<import('./gameDetails').GameDetailsService, 'findMany'> | null,
   *   presetPolicies?: Pick<import('./presetPolicies').PresetPoliciesService, 'current'> | null,
   *   now?: () => number,
   *   windowDays?: number,
   *   kFloor?: number,
   *   rowLimit?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.db) throw new Error("ClassifierQualityService: db required");
    this.db = deps.db;
    this.collection = deps.db.classifierQuality;
    this.gameDetails = deps.gameDetails || null;
    this.presetPolicies = deps.presetPolicies || null;
    this.now = deps.now || Date.now;
    this.windowDays = deps.windowDays || WINDOW_DAYS;
    this.kFloor = Math.max(K_FLOOR, deps.kFloor || K_FLOOR);
    this.rowLimit = deps.rowLimit || ROW_LIMIT;
  }

  /**
   * Build and store a fresh snapshot, then drop all but the newest
   * SNAPSHOTS_KEPT. Returns scalar counters for the job ledger.
   */
  async recompute() {
    this.assertIndexes();
    const generatedAt = new Date(this.now());
    const windowStart = new Date(generatedAt.getTime() - this.windowDays * DAY_MS);
    const tally = new Tally();
    let truncated = false;
    for (const axis of /** @type {Axis[]} */ (["build", "opponent"])) {
      let read = 0;
      const cursor = this.db.games
        .find(axisMatch(axis, windowStart, generatedAt), { projection: axisProjection(axis) })
        .sort({ [`${AXES[axis].intent}.confirmedAt`]: -1 })
        .limit(this.rowLimit + 1)
        .maxTimeMS(SCAN_MAX_TIME_MS);
      for await (const row of cursor) {
        if (++read > this.rowLimit) { truncated = true; break; }
        const checkIn = normalizeCheckIn(row, axis);
        if (checkIn) tally.add(checkIn);
      }
    }
    const snapshot = tally.finish(this.kFloor);
    const runId = crypto.randomUUID();
    await this.collection.insertOne(stampVersion({
      _id: /** @type {any} */ (runId), kind: "snapshot", generatedAt, windowStart,
      windowDays: this.windowDays, kFloor: this.kFloor, rowLimit: this.rowLimit,
      ...snapshot, totals: { ...snapshot.totals, truncated },
    }, COLLECTIONS.CLASSIFIER_QUALITY));
    const stale = await this.collection
      .find({ kind: "snapshot" }, { projection: { _id: 1 } })
      .sort({ generatedAt: -1 })
      .skip(SNAPSHOTS_KEPT)
      .toArray();
    if (stale.length) await this.collection.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
    return {
      checkIns: snapshot.totals.checkIns,
      disagreements: snapshot.totals.disagreements,
      pairs: snapshot.pairs.length,
      suppressedPairs: snapshot.totals.suppressedPairs,
      truncated,
    };
  }

  /** @returns {Promise<Record<string, any> | null>} */
  async latest() {
    return this.collection.findOne({ kind: "snapshot" }, { sort: { generatedAt: -1 }, projection: { _schemaVersion: 0 } });
  }

  /**
   * The admin console's view of the newest snapshot, narrowed by cohort.
   * Pairs are sorted by disagreement volume (with an engine filter, that
   * engine's share); every row already passed the k-floor.
   *
   * @param {{ axis?: Axis, matchup?: string, engine?: string }} [filters]
   */
  async consoleView(filters = {}) {
    const snap = await this.latest();
    if (!snap) return { snapshot: null, kFloor: this.kFloor, windowDays: this.windowDays, sampleLimit: SAMPLE_LIMIT };
    const pairs = (/** @type {any[]} */ (snap.pairs || []))
      .filter((pair) => (!filters.axis || pair.axis === filters.axis) && (!filters.matchup || pair.matchup === filters.matchup))
      .flatMap((pair) => {
        const scoped = scopePair(pair, filters.engine);
        return scoped ? [scoped] : [];
      })
      .sort((a, b) => b.count - a.count || b.users - a.users || compareText(a.declared, b.declared));
    const labels = (/** @type {any[]} */ (snap.labels || []))
      .filter((label) => !filters.axis || label.axis === filters.axis)
      .slice(0, VIEW_LIMIT);
    return {
      snapshot: {
        generatedAt: snap.generatedAt, windowStart: snap.windowStart, windowDays: snap.windowDays,
        kFloor: snap.kFloor, totals: snap.totals, engines: await this.engineTrends(snap), origins: snap.origins || {},
        matchups: [...new Set((/** @type {any[]} */ (snap.pairs || [])).map((pair) => pair.matchup))].sort(),
      },
      pairs: pairs.slice(0, VIEW_LIMIT),
      pairsTotal: pairs.length,
      labels,
      kFloor: snap.kFloor,
      windowDays: snap.windowDays,
      sampleLimit: SAMPLE_LIMIT,
    };
  }

  /** Keep only published engine cohorts from the bounded snapshot history.
   * @param {Record<string, any>} latest */
  async engineTrends(latest) {
    const prior = await this.collection.find({ kind: "snapshot", generatedAt: { $lt: latest.generatedAt } }, {
      projection: { _id: 0, generatedAt: 1, engines: 1 },
    }).sort({ generatedAt: -1 }).limit(SNAPSHOTS_KEPT - 1).toArray();
    const history = [...prior.reverse(), latest];
    return (/** @type {any[]} */ (latest.engines || [])).map((engine) => ({
      ...engine,
      trend: history.flatMap((snapshot) => {
        const row = snapshot.engines?.find((/** @type {any} */ item) => item.engine === engine.engine);
        return row ? [{ generatedAt: snapshot.generatedAt, disagreements: row.disagreements }] : [];
      }),
    }));
  }

  /**
   * Up to SAMPLE_LIMIT recent games behind one published disagreement pair,
   * each with the first six minutes of the relevant build log, next to the
   * declared (and detected) rule's requirements. Samples carry no user, game
   * or opponent identity, so "Copy as test fixture" exports only engine input.
   *
   * @param {{ axis: Axis, matchup: string, detected: string, declared: string, engine?: string }} pair
   */
  async samples(pair) {
    this.assertIndexes();
    const snap = await this.latest();
    const pairRow = snap && (/** @type {any[]} */ (snap.pairs || [])).find((row) => row.axis === pair.axis
      && row.matchup === pair.matchup && row.detected === pair.detected && row.declared === pair.declared);
    const published = pairRow && scopePair(pairRow, pair.engine);
    if (!snap || !published) {
      throw Object.assign(new Error("classifier_pair_not_found"), { status: 404, code: "classifier_pair_not_found" });
    }
    const intent = AXES[pair.axis].intent;
    const rows = await this.db.games
      .find({ $and: [axisMatch(pair.axis, snap.windowStart, snap.generatedAt), matchupQuery(pair.axis, pair.matchup),
        labelQuery(`${intent}.build`, pair.declared, "declared"), labelQuery(`${intent}.detected`, pair.detected, "detected"), engineQuery(pair.engine)] },
      { projection: { ...axisProjection(pair.axis), gameId: 1, date: 1, map: 1, durationSec: 1, gameVersion: 1 } })
      .sort({ [`${intent}.confirmedAt`]: -1 })
      .limit(SAMPLE_LIMIT * 3)
      .maxTimeMS(SAMPLE_MAX_TIME_MS)
      .toArray();
    const matching = rows.filter((row) => {
      const checkIn = normalizeCheckIn(row, pair.axis);
      return checkIn && !checkIn.agree && checkIn.detected === pair.detected && checkIn.declared === pair.declared
        && checkIn.matchup === pair.matchup && (!pair.engine || checkIn.engine === pair.engine);
    });
    // A snapshot may outlive a corrected or deleted check-in. Keep the
    // floor on the current bounded sample before reading replay details.
    const sampleRows = new Set(matching.map((row) => row.userId)).size >= snap.kFloor ? matching.slice(0, SAMPLE_LIMIT) : [];
    const logs = await this.buildLogs(sampleRows, pair.axis === "build" ? "buildLog" : "oppBuildLog");
    const policy = this.presetPolicies ? await this.presetPolicies.current().catch(() => null) : null;
    return {
      pair: published,
      windowStart: snap.windowStart,
      sampleLimit: SAMPLE_LIMIT,
      sampleSeconds: SAMPLE_SECONDS,
      rules: { declared: ruleFor(pair.declared, policy), detected: ruleFor(pair.detected, policy) },
      samples: sampleRows.map((row, index) => {
        const checkIn = /** @type {CheckIn} */ (normalizeCheckIn(row, pair.axis));
        const log = firstMinutes(logs[index]);
        return {
          sample: index + 1,
          day: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : null,
          map: typeof row.map === "string" ? row.map : null,
          durationSec: typeof row.durationSec === "number" ? row.durationSec : null,
          gameVersion: typeof row.gameVersion === "string" ? row.gameVersion : null,
          engine: checkIn.engine,
          origin: checkIn.origin,
          race: raceName(pair.axis === "build" ? row.myRace : row.opponent?.race),
          opponentRace: raceName(pair.axis === "build" ? row.opponent?.race : row.myRace),
          buildLog: log.lines,
          buildLogAvailable: log.available,
          buildLogTruncated: log.truncated,
        };
      }),
    };
  }

  /**
   * Released preset labels with "matches N of M player corrections", both
   * axes combined; a label appears only once K_FLOOR distinct users declared
   * it. Public: no custom names, users or games.
   */
  async publicTrust() {
    const snap = await this.latest();
    return {
      generatedAt: snap ? snap.generatedAt : null,
      windowDays: snap ? snap.windowDays : this.windowDays,
      kFloor: snap ? snap.kFloor : this.kFloor,
      labels: snap ? snap.trust || [] : [],
    };
  }

  /** Nothing scans the games collection before its partial indexes exist. */
  assertIndexes() {
    const builds = this.db.classifierQualityIndexes;
    if (!builds) return;
    for (const { index } of Object.values(AXES)) {
      if (builds.status(index) !== "ready") {
        throw Object.assign(new Error("classifier_quality_index_unavailable"), { status: 503, code: "classifier_quality_index_unavailable" });
      }
    }
  }

  /**
   * One detail read per owner, in sample order. A failed or missing detail
   * row only marks that sample's log unavailable.
   *
   * @param {any[]} rows
   * @param {"buildLog"|"oppBuildLog"} field
   * @returns {Promise<Array<unknown>>}
   */
  async buildLogs(rows, field) {
    /** @type {Map<string, string[]>} */
    const byOwner = new Map();
    for (const row of rows) {
      const ids = byOwner.get(row.userId) || [];
      ids.push(String(row.gameId));
      byOwner.set(row.userId, ids);
    }
    /** @type {Map<string, Map<string, Record<string, any>>>} */
    const details = new Map();
    await Promise.all([...byOwner].map(async ([userId, gameIds]) => {
      const found = await this.gameDetails?.findMany(userId, gameIds, { fields: [field], concurrency: 2 }).catch(() => null) || new Map();
      const missing = gameIds.filter((id) => !Array.isArray(found.get(id)?.[field]));
      if (missing.length) {
        const legacy = await this.db.games.find({ userId, gameId: { $in: missing }, ...LIVE_GAME_MATCH }, {
          projection: { _id: 0, gameId: 1, [field]: 1 }, maxTimeMS: SAMPLE_MAX_TIME_MS,
        }).toArray();
        for (const row of legacy) found.set(row.gameId, row);
      }
      details.set(userId, found);
    }));
    return rows.map((row) => details.get(row.userId)?.get(String(row.gameId))?.[field]);
  }
}

/** Running tallies for one recompute; only finish() output is persisted. */
class Tally {
  constructor() {
    /** @type {Map<string, any>} */ this.pairs = new Map();
    /** @type {Map<string, any>} */ this.labels = new Map();
    /** @type {Map<string, any>} */ this.trust = new Map();
    /** @type {Map<string, any>} */ this.engines = new Map();
    /** @type {Record<string, number>} */ this.origins = { pregame: 0, postgame: 0, web: 0, other: 0 };
    this.checkIns = 0;
    this.disagreements = 0;
    /** @type {Set<string>} */ this.users = new Set();
  }

  /** @param {CheckIn} c */
  add(c) {
    this.checkIns += 1;
    this.users.add(c.userId);
    this.origins[c.origin] += 1;
    const engine = upsert(this.engines, c.engine, () => ({ engine: c.engine, checkIns: 0, disagreements: 0, users: new Set() }));
    engine.checkIns += 1;
    engine.users.add(c.userId);
    const declared = this.label(c.axis, c.declared);
    declared.users.add(c.userId);
    declared.declaredUsers.add(c.userId);
    if (CATALOG.has(c.declared)) {
      const trust = upsert(this.trust, c.declared, () => ({ label: c.declared, matches: 0, corrections: 0, users: new Set() }));
      trust.corrections += 1;
      if (c.agree) trust.matches += 1;
      trust.users.add(c.userId);
    }
    if (c.agree) { declared.agree += 1; return; }
    this.disagreements += 1;
    engine.disagreements += 1;
    declared.missed += 1;
    if (c.detected !== c.declared) {
      const detected = this.label(c.axis, c.detected);
      detected.mislabeled += 1;
      detected.users.add(c.userId);
    }
    const pair = upsert(this.pairs, JSON.stringify([c.axis, c.matchup, c.detected, c.declared]), () => ({
      axis: c.axis, matchup: c.matchup, detected: c.detected, declared: c.declared, count: 0,
      users: new Set(), engines: new Map(), origins: { pregame: 0, postgame: 0, web: 0, other: 0 }, lastConfirmedAt: null,
    }));
    pair.count += 1;
    pair.users.add(c.userId);
    const byEngine = upsert(pair.engines, c.engine, () => ({
      engine: c.engine, count: 0, users: new Set(), origins: { pregame: 0, postgame: 0, web: 0, other: 0 }, lastConfirmedAt: /** @type {Date|null} */ (null),
    }));
    byEngine.count += 1;
    byEngine.users.add(c.userId);
    byEngine.origins[c.origin] += 1;
    if (c.confirmedAt && (!byEngine.lastConfirmedAt || c.confirmedAt > byEngine.lastConfirmedAt)) byEngine.lastConfirmedAt = c.confirmedAt;
    pair.origins[c.origin] += 1;
    if (c.confirmedAt && (!pair.lastConfirmedAt || c.confirmedAt > pair.lastConfirmedAt)) pair.lastConfirmedAt = c.confirmedAt;
  }

  /** @param {Axis} axis @param {string} label */
  label(axis, label) {
    return upsert(this.labels, JSON.stringify([axis, label]), () => ({
      axis, label, agree: 0, missed: 0, mislabeled: 0, users: new Set(), declaredUsers: new Set(),
    }));
  }

  /** @param {number} kFloor */
  finish(kFloor) {
    const allPairs = [...this.pairs.values()];
    const pairs = allPairs.filter((pair) => pair.users.size >= kFloor);
    const suppressed = allPairs.filter((pair) => pair.users.size < kFloor);
    return {
      totals: {
        checkIns: this.checkIns, disagreements: this.disagreements, users: this.users.size,
        suppressedPairs: suppressed.length,
        suppressedCheckIns: suppressed.reduce((sum, pair) => sum + pair.count, 0),
      },
      origins: this.origins,
      engines: [...this.engines.values()].filter((row) => row.users.size >= kFloor)
        .sort((a, b) => b.checkIns - a.checkIns || compareEngines(a.engine, b.engine)).slice(0, ENGINES_KEPT)
        .map((row) => ({ engine: row.engine, checkIns: row.checkIns, disagreements: row.disagreements, users: row.users.size }))
        .sort((a, b) => compareEngines(a.engine, b.engine)),
      pairs: pairs
        .sort((a, b) => b.count - a.count || b.users.size - a.users.size || compareText(a.declared, b.declared))
        .slice(0, PAIRS_KEPT)
        .map((pair) => ({
          axis: pair.axis, matchup: pair.matchup, detected: pair.detected, declared: pair.declared,
          count: pair.count, users: pair.users.size, origins: pair.origins, lastConfirmedAt: pair.lastConfirmedAt,
          engines: publishPairEngines(pair.engines, kFloor),
        })),
      labels: [...this.labels.values()].filter((row) => row.users.size >= kFloor)
        .sort((a, b) => (b.missed + b.mislabeled) - (a.missed + a.mislabeled) || compareText(a.label, b.label))
        .slice(0, LABELS_KEPT)
        .map((row) => ({ axis: row.axis, label: row.label, agree: row.agree, missed: row.missed, mislabeled: row.mislabeled, users: row.users.size })),
      trust: [...this.trust.values()].filter((row) => row.users.size >= kFloor)
        .map((row) => ({ label: row.label, matches: row.matches, corrections: row.corrections }))
        .sort((a, b) => compareText(a.label, b.label)),
    };
  }
}

/** @param {Map<string, any>} engines @param {number} kFloor */
function publishPairEngines(engines, kFloor) {
  return [...engines.values()].filter((row) => row.users.size >= kFloor)
    .sort((a, b) => b.count - a.count || compareEngines(a.engine, b.engine)).slice(0, PAIR_ENGINES_KEPT)
    .map((row) => ({ ...row, users: row.users.size }));
}

/** @param {any} pair @param {string} [engine] */
function scopePair(pair, engine) {
  if (!engine) return pair;
  const row = pair.engines.find((/** @type {any} */ item) => item.engine === engine);
  return row ? { ...pair, ...row, engines: [row] } : null;
}

/**
 * One check-in as the console counts it, or null for a row that cannot be
 * attributed (no owner or declared build).
 *
 * @param {any} row
 * @param {Axis} axis
 * @returns {CheckIn | null}
 */
function normalizeCheckIn(row, axis) {
  const intent = axis === "build" ? row?.buildIntent : row?.buildIntent?.opponent;
  const declared = intent && intent.build && typeof intent.build === "object" ? intent.build : null;
  if (!declared || typeof declared.name !== "string" || typeof row.userId !== "string" || !row.userId) return null;
  const detected = intent.detected && typeof intent.detected === "object" ? intent.detected : {};
  const declaredSlug = typeof declared.slug === "string" && declared.slug ? declared.slug : null;
  const detectedSlug = typeof detected.slug === "string" && detected.slug ? detected.slug : null;
  const detectedName = typeof detected.name === "string" && detected.name ? detected.name : null;
  const mine = raceLetter(row.myRace), theirs = raceLetter(row.opponent?.race);
  const [first, second] = axis === "build" ? [mine, theirs] : [theirs, mine];
  return {
    axis,
    userId: row.userId,
    matchup: first && second ? `${first}v${second}` : "Unknown",
    engine: engineOf(row),
    declared: declared.source === "custom" || declaredSlug ? CUSTOM_LABEL : canonicalLabel(declared.name),
    detected: detectedSlug ? CUSTOM_LABEL : detectedName ? canonicalLabel(detectedName) : NO_LABEL,
    // The same test as buildIntentShape's LABELS_AGREE_EXPR: same name, same slug.
    agree: declared.name === detectedName && declaredSlug === detectedSlug,
    origin: ORIGINS.includes(intent.origin) ? intent.origin : "other",
    confirmedAt: intent.confirmedAt instanceof Date ? intent.confirmedAt : null,
  };
}

/** @param {Axis} axis @param {Date} windowStart @param {Date} windowEnd */
function axisMatch(axis, windowStart, windowEnd) {
  const intent = AXES[axis].intent;
  return {
    ...LIVE_GAME_MATCH,
    [`${intent}.status`]: "confirmed",
    [`${intent}.applied`]: true,
    [`${intent}.confirmedAt`]: { $gte: windowStart, $lte: windowEnd },
  };
}

/** @param {Axis} axis */
function axisProjection(axis) {
  const intent = AXES[axis].intent;
  return {
    _id: 0, userId: 1, myRace: 1, "opponent.race": 1, ingestSource: 1, engineVersion: 1,
    [`${intent}.build`]: 1, [`${intent}.detected`]: 1, [`${intent}.origin`]: 1, [`${intent}.confirmedAt`]: 1,
  };
}

/** @param {Axis} axis @param {string} matchup */
function matchupQuery(axis, matchup) {
  if (matchup === "Unknown") return {};
  const [own, other] = axis === "build" ? [matchup[0], matchup[2]] : [matchup[2], matchup[0]];
  return { myRace: new RegExp(`^${own}`, "i"), "opponent.race": new RegExp(`^${other}`, "i") };
}

/**
 * Narrow a sample scan to a label; normalizeCheckIn makes the exact call.
 * @param {string} path @param {string} label @param {"declared"|"detected"} role
 */
function labelQuery(path, label, role) {
  if (label === CUSTOM_LABEL) {
    const hasSlug = { [`${path}.slug`]: { $type: "string", $ne: "" } };
    return role === "declared" ? { $or: [{ [`${path}.source`]: "custom" }, hasSlug] } : hasSlug;
  }
  if (label === NO_LABEL) return { [`${path}.name`]: { $in: [null, ""] } };
  if (label === UNLISTED_LABEL) return { [`${path}.name`]: { $nin: [null, "", ...CANONICAL.keys()] } };
  return { [`${path}.name`]: { $in: [...CANONICAL].filter(([, name]) => name === label).map(([alias]) => alias).concat(CANONICAL.has(label) ? [] : [label]) } };
}

/**
 * The rule text and any active Build Studio policy for a released label;
 * null for a custom build (the owner's private rules) or an unlisted label.
 *
 * @param {string} label @param {any} policy
 */
function ruleFor(label, policy) {
  const entry = CATALOG.get(label);
  if (!entry) return null;
  const edit = policy && Array.isArray(policy.entries)
    ? policy.entries.find((/** @type {any} */ row) => row.name === label) : null;
  return {
    name: entry.name,
    description: entry.description,
    surfaces: entry.surfaces,
    implementation: entry.implementation,
    releasedCriteria: entry.releasedCriteria ?? [],
    policy: edit ? {
      revision: policy.revision, enabled: edit.enabled, mode: edit.mode || "replacement",
      anyOf: edit.anyOf, steps: edit.steps || [], description: edit.description || null,
    } : null,
  };
}

/**
 * Allowlisted game events at or before 6:00. Older and browser-supplied
 * logs can contain free text, so copy only recognized entity names.
 *
 * @param {unknown} raw
 * @returns {{ lines: string[], available: boolean, truncated: boolean }}
 */
function firstMinutes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { lines: [], available: false, truncated: false };
  /** @type {string[]} */
  const lines = [];
  let truncated = raw.length > 5000;
  for (const line of raw.slice(0, 5000)) {
    if (typeof line !== "string" || line.length > 120) continue;
    const match = /^\[(\d{1,3}):([0-5]\d)\]\s+([A-Za-z][A-Za-z0-9 ]{0,79})$/.exec(line.trim());
    if (!match) continue;
    if (Number(match[1]) * 60 + Number(match[2]) > SAMPLE_SECONDS) { truncated = true; continue; }
    const entity = match[3];
    if (!isKnownBuilding(entity) && !isKnownUpgrade(entity) && buildSecondsFor(entity) === null) continue;
    if (lines.length >= SAMPLE_LINES_MAX) { truncated = true; break; }
    lines.push(`[${match[1]}:${match[2]}] ${entity}`);
  }
  return { lines, available: lines.length > 0, truncated };
}

/** @param {unknown} raw */
function raceLetter(raw) {
  const letter = typeof raw === "string" ? raw.trim().charAt(0).toUpperCase() : "";
  return letter === "P" || letter === "T" || letter === "Z" ? letter : null;
}

/** @param {unknown} raw */
function raceName(raw) {
  const letter = raceLetter(raw);
  return letter === "P" ? "Protoss" : letter === "T" ? "Terran" : letter === "Z" ? "Zerg" : null;
}

/** The uploader and its reported engine; legacy rows can lack both. @param {any} row */
function engineOf(row) {
  if (!INGEST_PROVENANCE.SOURCES.includes(row.ingestSource)) return "unknown";
  const version = row.engineVersion;
  return typeof version === "string" && version.length <= INGEST_PROVENANCE.ENGINE_VERSION_MAX_LENGTH && ENGINE_VERSION_RE.test(version)
    ? `${row.ingestSource}:${version}` : row.ingestSource;
}

/** @param {string} [engine] */
function engineQuery(engine) {
  if (!engine) return {};
  const [source, ...version] = engine.split(":");
  if (source === "unknown") return { ingestSource: { $nin: [...INGEST_PROVENANCE.SOURCES] } };
  return version.length ? { ingestSource: source, engineVersion: version.join(":") } : { ingestSource: source };
}

/** @param {string} name */
function canonicalLabel(name) {
  const trimmed = name.trim().slice(0, LABEL_MAX);
  return CANONICAL.get(trimmed) || UNLISTED_LABEL;
}

/**
 * @template T
 * @param {Map<string, T>} map @param {string} key @param {() => T} create
 * @returns {T}
 */
function upsert(map, key, create) {
  let row = map.get(key);
  if (!row) { row = create(); map.set(key, row); }
  return row;
}

/** @param {string} a @param {string} b */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order uploader groups by reported versions, with unversioned rows last. @param {string} a @param {string} b */
function compareEngines(a, b) {
  const rank = (/** @type {string} */ e) => e.startsWith("agent:") ? 0 : e.startsWith("browser:") ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const parts = (/** @type {string} */ e) => e.replace(/^(?:agent|browser):/, "").split(/[.+-]/).map((part) => Number(part) || 0);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);
  }
  return compareText(a, b);
}

/**
 * Query validation shared by the admin routes: an unknown value is a 400.
 * @param {Record<string, unknown>} query
 * @param {{ requirePair?: boolean }} [opts]
 */
function parseCohortQuery(query, opts = {}) {
  const bad = (/** @type {string} */ field) => Object.assign(new Error(`invalid_${field}`), { status: 400, code: "invalid_classifier_query" });
  /** @type {Record<string, any>} */
  const out = {};
  if (query.axis !== undefined && query.axis !== "") {
    if (query.axis !== "build" && query.axis !== "opponent") throw bad("axis");
    out.axis = query.axis;
  }
  if (query.matchup !== undefined && query.matchup !== "") {
    if (typeof query.matchup !== "string" || !MATCHUP_RE.test(query.matchup)) throw bad("matchup");
    out.matchup = query.matchup;
  }
  for (const key of ["engine", "detected", "declared"]) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(value)) throw bad(key);
    out[key] = value;
  }
  if (opts.requirePair && (!out.axis || !out.matchup || !out.detected || !out.declared)) throw bad("pair");
  return out;
}

module.exports = {
  ClassifierQualityService,
  normalizeCheckIn,
  parseCohortQuery,
  firstMinutes,
  WINDOW_DAYS,
  K_FLOOR,
  SAMPLE_LIMIT,
  SAMPLE_SECONDS,
  CUSTOM_LABEL,
  NO_LABEL,
};
