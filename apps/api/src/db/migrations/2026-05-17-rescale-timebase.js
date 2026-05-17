"use strict";

/**
 * One-shot migration — rescale every stored game timestamp from the
 * broken 16fps scale (sc2reader's ``event.second = frame // 16``) to
 * real LotV game seconds (22.4fps). Multiply every stored second by
 * ``16 / 22.4`` ≈ 0.714.
 *
 * Why
 * ---
 * The extractor fix shipped in PR #309 ("fix(timebase): emit real
 * game-time seconds (22.4 fps) on every event"). Going forward every
 * fresh ingest writes correct timestamps. Everything ingested before
 * that PR is still in the database at the broken scale — a stored
 * "Nexus at [4:57]" was really mined at 3:32. This script rewrites
 * the back-history so the new readers (phase classifier, build
 * dossier, custom build matcher) see consistent numbers regardless
 * of when the game was uploaded.
 *
 * Depends on the PR #309 agent rollout. Run AFTER the new agent has
 * been deployed — otherwise concurrent ingests will overwrite the
 * migration's work with fresh broken-scale data.
 *
 * What gets rewritten
 * -------------------
 *   games (slim row)
 *     buildLog[*], oppBuildLog[*], earlyBuildLog[*], oppEarlyBuildLog[*]
 *
 *   gameDetails (heavy blobs)
 *     buildLog[*], oppBuildLog[*], earlyBuildLog[*], oppEarlyBuildLog[*]
 *     macroBreakdown.stats_events[*].time
 *     macroBreakdown.opp_stats_events[*].time
 *     macroBreakdown.bases[*].born_time
 *     macroBreakdown.bases[*].died_time        (survived-sentinel aware)
 *     macroBreakdown.production_buildings[*].born_time
 *     macroBreakdown.production_buildings[*].died_time   (survived-sentinel)
 *     macroBreakdown.unit_timeline[*].time
 *     macroBreakdown.ability_events[*].time
 *     macroBreakdown.unit_births[*].time
 *     macroBreakdown.game_length_sec    (only when broken-scale; see below)
 *     apmCurve.players[*].samples[*].t
 *
 *   customBuilds, communityBuilds
 *     rules[*].time_lt
 *     signature[*].beforeSec
 *
 *   derived caches (timing_catalog, build_dossier, dna_timings, …)
 *     Dropped where present — they regenerate on next read.
 *
 * What is NOT touched
 * -------------------
 *   * ``games.durationSec`` — derived from ``replay.length.seconds``
 *     and was always correct.
 *   * ``macroBreakdown.game_length_sec`` — left as-is when it already
 *     matches the slim row's durationSec (most rows). Only rewritten
 *     when the extractor sourced it from broken-scale data, which is
 *     detectable: the broken value is ~1.4× durationSec. If the ratio
 *     ``game_length_sec / durationSec`` is in [1.35, 1.45] we rewrite
 *     to durationSec.
 *
 * Survived-sentinel handling
 * --------------------------
 * The extractor caps a base/production_building's ``died_time`` at
 * the blob's ``game_length_sec`` when it survived to the end. After
 * rescaling, those died_times need to map to the REAL end-of-game
 * (slim ``durationSec``), not the rescaled broken sentinel. We detect
 * "survived" entries BEFORE rescaling by comparing against the raw
 * ``game_length_sec``, then overwrite their died_time with the slim
 * durationSec after rescaling the rest.
 *
 * Idempotency
 * -----------
 * Each migrated document is stamped with ``_timebaseScaledAt`` (a
 * ``Date``). Re-runs skip docs that already carry the field. Pass
 * ``--force`` to re-run anyway — useful if you spot-check a bug,
 * fix it here, and need to re-scan. Note that --force WITHOUT first
 * restoring the snapshot will double-rescale and corrupt data.
 *
 * Snapshots + rollback
 * --------------------
 * Before each collection's first write the script copies the
 * affected collection to ``<name>_timebase_pre`` (e.g.
 * ``games_timebase_pre``, ``gameDetails_timebase_pre``,
 * ``customBuilds_timebase_pre``, ``communityBuilds_timebase_pre``).
 * The snapshot is created only if it doesn't already exist — re-runs
 * preserve the original pristine state.
 *
 * To roll a collection back:
 *   1. mongosh:  use sc2tools_saas
 *   2.           db.games.drop()
 *   3.           db.games_timebase_pre.aggregate([{$out: 'games'}])
 *   4. Repeat per collection.
 *
 * Usage
 * -----
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-17-rescale-timebase.js [flags]
 *
 *   --dry-run        Print planned counts without writing.
 *   --force          Re-scale docs even if _timebaseScaledAt is set.
 *   --batch=N        Override default bulkWrite chunk size (500).
 *   --user=USER_ID   Restrict to one user (support triage).
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);

/** Scale factor: broken 16fps → real 22.4fps  ⇒  multiply by 16/22.4. */
const SCALE = 16 / 22.4;

const DEFAULT_BATCH = 500;

/** Snapshot suffix appended to each rewritten collection name. */
const SNAPSHOT_SUFFIX = "_timebase_pre";

/**
 * Names of derived-cache collections that the migration should drop
 * if present. These are regenerated lazily on read, so dropping is
 * cheaper and safer than rewriting per-doc. Missing collections are
 * a no-op.
 */
const DERIVED_CACHE_COLLECTIONS = Object.freeze([
  "timing_catalog",
  "timingCatalog",
  "build_dossier",
  "buildDossier",
  "dna_timings",
  "dnaTimings",
  "build_durations",
  "buildDurations",
]);

/**
 * Detect a doc that's already been rescaled by an earlier run. Idempotency
 * fence — set on every doc the migration writes, checked by the per-doc
 * planner so re-running is a no-op without ``--force``.
 *
 * @param {any} doc
 * @returns {boolean}
 */
function alreadyScaled(doc) {
  return !!(doc && doc._timebaseScaledAt);
}

/**
 * Rescale one number-of-seconds value to real game-time. Negative and
 * NaN inputs collapse to 0 — defensive but never expected.
 *
 * @param {number} sec
 * @returns {number}
 */
function rescaleSec(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return 0;
  return Math.max(0, Math.round(sec * SCALE));
}

/**
 * Rescale one ``[m:ss] Label`` build-log line. Lines that don't match
 * the expected shape (rare malformed entries, agent debug noise) pass
 * through unchanged so we never corrupt unknown content.
 *
 * @param {string} line
 * @returns {string}
 */
function rescaleBuildLogLine(line) {
  if (typeof line !== "string") return line;
  const m = /^\[(\d+):(\d{2})\]\s+(.+)$/.exec(line);
  if (!m) return line;
  const broken = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const real = rescaleSec(broken);
  const mm = Math.floor(real / 60);
  const ss = String(real % 60).padStart(2, "0");
  return `[${mm}:${ss}] ${m[3]}`;
}

/**
 * Rescale every line in an array of build-log strings. Returns the
 * rewritten array (new instance) or ``undefined`` if the input is not
 * an array — callers use ``undefined`` to mean "leave the field alone".
 *
 * @param {any} arr
 * @returns {string[] | undefined}
 */
function rescaleBuildLogArray(arr) {
  if (!Array.isArray(arr)) return undefined;
  return arr.map(rescaleBuildLogLine);
}

/**
 * Rescale ``time`` on every entry of a time-keyed array
 * (stats_events, opp_stats_events, unit_timeline, ability_events,
 * unit_births). Returns a new array with the same shape but rewritten
 * ``time`` values; entries without a numeric time pass through.
 *
 * @param {any} arr
 * @returns {any[] | undefined}
 */
function rescaleTimeKeyedArray(arr) {
  if (!Array.isArray(arr)) return undefined;
  return arr.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.time !== "number") {
      return entry;
    }
    return { ...entry, time: rescaleSec(entry.time) };
  });
}

/**
 * Rescale the bases / production_buildings arrays. Each entry has
 * ``born_time`` and ``died_time``; survivors (died_time >= brokenEnd)
 * get their died_time pinned to ``realDurationSec`` so the
 * phaseClassifier doesn't mis-treat them as deaths.
 *
 * @param {any} arr
 * @param {number} brokenEnd
 * @param {number} realDurationSec
 * @returns {any[] | undefined}
 */
function rescaleBornDiedArray(arr, brokenEnd, realDurationSec) {
  if (!Array.isArray(arr)) return undefined;
  return arr.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    /** @type {Record<string, any>} */
    const next = { ...entry };
    if (typeof entry.born_time === "number") {
      next.born_time = rescaleSec(entry.born_time);
    }
    if (typeof entry.died_time === "number") {
      // Sentinel: at-or-past the broken end ⇒ "survived". Pin to the
      // real durationSec rather than rescaling the cap.
      const survived =
        Number.isFinite(brokenEnd) && brokenEnd > 0
          ? entry.died_time >= brokenEnd
          : false;
      next.died_time = survived ? realDurationSec : rescaleSec(entry.died_time);
    }
    return next;
  });
}

/**
 * Decide whether the blob's ``game_length_sec`` came from broken-scale
 * data. Broken sources are ~1.4× the real durationSec; ratios outside
 * [1.35, 1.45] indicate the field was already populated from the
 * replay header (real seconds) and should be left alone.
 *
 * @param {number} gameLengthSec
 * @param {number} realDurationSec
 * @returns {boolean}
 */
function isBrokenScaleGameLength(gameLengthSec, realDurationSec) {
  if (typeof gameLengthSec !== "number" || !Number.isFinite(gameLengthSec)) {
    return false;
  }
  if (typeof realDurationSec !== "number" || !(realDurationSec > 0)) {
    return false;
  }
  const ratio = gameLengthSec / realDurationSec;
  return ratio >= 1.35 && ratio <= 1.45;
}

/**
 * Rescale the apmCurve blob's per-player samples. Each sample has a
 * numeric ``t``; ``apm`` / ``spm`` values are rates, not times, so
 * they're left alone.
 *
 * @param {any} curve
 * @returns {any}
 */
function rescaleApmCurve(curve) {
  if (!curve || typeof curve !== "object") return curve;
  if (!Array.isArray(curve.players)) return curve;
  const players = curve.players.map(/** @param {any} p */ (p) => {
    if (!p || typeof p !== "object" || !Array.isArray(p.samples)) return p;
    const samples = p.samples.map(/** @param {any} s */ (s) => {
      if (!s || typeof s !== "object" || typeof s.t !== "number") return s;
      return { ...s, t: rescaleSec(s.t) };
    });
    return { ...p, samples };
  });
  return { ...curve, players };
}

/**
 * Rescale the macroBreakdown blob in place (returns a new copy).
 * Reads the broken game_length_sec FIRST so survived-sentinel detection
 * uses the raw value.
 *
 * @param {any} macroBreakdown
 * @param {number} realDurationSec
 * @returns {any}
 */
function rescaleMacroBreakdown(macroBreakdown, realDurationSec) {
  if (!macroBreakdown || typeof macroBreakdown !== "object") {
    return macroBreakdown;
  }
  const brokenEnd =
    typeof macroBreakdown.game_length_sec === "number"
      ? macroBreakdown.game_length_sec
      : 0;
  /** @type {Record<string, any>} */
  const next = { ...macroBreakdown };
  if (Array.isArray(macroBreakdown.stats_events)) {
    next.stats_events = rescaleTimeKeyedArray(macroBreakdown.stats_events);
  }
  if (Array.isArray(macroBreakdown.opp_stats_events)) {
    next.opp_stats_events = rescaleTimeKeyedArray(
      macroBreakdown.opp_stats_events,
    );
  }
  if (Array.isArray(macroBreakdown.bases)) {
    next.bases = rescaleBornDiedArray(
      macroBreakdown.bases,
      brokenEnd,
      realDurationSec,
    );
  }
  if (Array.isArray(macroBreakdown.production_buildings)) {
    next.production_buildings = rescaleBornDiedArray(
      macroBreakdown.production_buildings,
      brokenEnd,
      realDurationSec,
    );
  }
  if (Array.isArray(macroBreakdown.unit_timeline)) {
    next.unit_timeline = rescaleTimeKeyedArray(macroBreakdown.unit_timeline);
  }
  if (Array.isArray(macroBreakdown.ability_events)) {
    next.ability_events = rescaleTimeKeyedArray(macroBreakdown.ability_events);
  }
  if (Array.isArray(macroBreakdown.unit_births)) {
    next.unit_births = rescaleTimeKeyedArray(macroBreakdown.unit_births);
  }
  if (isBrokenScaleGameLength(brokenEnd, realDurationSec)) {
    next.game_length_sec = realDurationSec;
  }
  return next;
}

/**
 * Rescale a customBuilds / communityBuilds doc's rules + signature
 * arrays. Returns the patch ($set payload) — never the full doc — so
 * the caller can decide whether to issue an update.
 *
 * @param {any} doc
 * @returns {Record<string, any>}
 */
function customBuildSetPatch(doc) {
  /** @type {Record<string, any>} */
  const set = {};
  if (Array.isArray(doc.rules)) {
    set.rules = doc.rules.map(/** @param {any} r */ (r) => {
      if (!r || typeof r !== "object" || typeof r.time_lt !== "number") return r;
      return { ...r, time_lt: rescaleSec(r.time_lt) };
    });
  }
  if (Array.isArray(doc.signature)) {
    set.signature = doc.signature.map(/** @param {any} s */ (s) => {
      if (!s || typeof s !== "object" || typeof s.beforeSec !== "number") {
        return s;
      }
      return { ...s, beforeSec: rescaleSec(s.beforeSec) };
    });
  }
  return set;
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pretty-print a banner so the operator sees which segment is in
 * flight. Each top-level call to ``step`` wraps one collection's work.
 *
 * @param {string} label
 * @param {() => Promise<{scanned:number, planned:number, written:number}>} fn
 */
async function step(label, fn) {
  const tStart = Date.now();
  console.log(`\n=== ${label} ===`);
  const r = await fn();
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(
    `--- ${label}: scanned=${r.scanned} planned=${r.planned} ` +
      `written=${r.written} (${elapsed}s)`,
  );
  return r;
}

/**
 * Snapshot a collection to ``<name>${SNAPSHOT_SUFFIX}`` if no snapshot
 * exists yet. Uses $out so the copy is server-side and atomic per-batch.
 * Skips if the snapshot collection already has documents (idempotent
 * re-runs preserve the pristine original state).
 *
 * @param {import('mongodb').Db} db
 * @param {string} name
 */
async function ensureSnapshot(db, name) {
  const target = `${name}${SNAPSHOT_SUFFIX}`;
  const existing = await db.collection(target).countDocuments({}, { limit: 1 });
  if (existing > 0) {
    console.log(`  snapshot ${target} already exists; skipping copy.`);
    return;
  }
  const src = await db.collection(name).countDocuments({}, { limit: 1 });
  if (src === 0) {
    console.log(`  source ${name} is empty; no snapshot needed.`);
    return;
  }
  console.log(`  snapshotting ${name} → ${target} …`);
  await db
    .collection(name)
    .aggregate([{ $out: target }], { allowDiskUse: true })
    .toArray();
}

/**
 * Standard bulkWrite chunk runner. Flushes when ``ops`` reaches
 * ``batch`` and once more at the end. Returns the modified count.
 *
 * @param {import('mongodb').Collection} coll
 * @param {Array<any>} ops
 * @param {boolean} dryRun
 * @returns {Promise<number>}
 */
async function flushBulk(coll, ops, dryRun) {
  if (ops.length === 0) return 0;
  if (dryRun) {
    const n = ops.length;
    ops.length = 0;
    return n;
  }
  const res = await coll.bulkWrite(ops, { ordered: false });
  ops.length = 0;
  return res.modifiedCount || 0;
}

/**
 * Rewrite the slim ``games`` collection's build-log fields.
 *
 * @param {import('mongodb').Db} db
 * @param {{dryRun:boolean, force:boolean, batch:number, user:string|null}} opts
 */
async function runGames(db, opts) {
  const coll = db.collection(COLLECTIONS.GAMES);
  if (!opts.dryRun) await ensureSnapshot(db, COLLECTIONS.GAMES);

  /** @type {Record<string, any>} */
  const filter = {};
  if (opts.user) filter.userId = opts.user;
  if (!opts.force) filter._timebaseScaledAt = { $exists: false };

  const cursor = coll.find(filter, {
    projection: {
      _id: 1,
      buildLog: 1,
      oppBuildLog: 1,
      earlyBuildLog: 1,
      oppEarlyBuildLog: 1,
      _timebaseScaledAt: 1,
    },
  });

  let scanned = 0;
  let planned = 0;
  let written = 0;
  /** @type {any[]} */
  const ops = [];
  const stampedAt = new Date();

  for await (const doc of cursor) {
    scanned += 1;
    if (!opts.force && alreadyScaled(doc)) continue;
    /** @type {Record<string, any>} */
    const set = { _timebaseScaledAt: stampedAt };
    const fields = [
      "buildLog",
      "oppBuildLog",
      "earlyBuildLog",
      "oppEarlyBuildLog",
    ];
    let anyChange = false;
    for (const f of fields) {
      const rescaled = rescaleBuildLogArray(doc[f]);
      if (rescaled) {
        set[f] = rescaled;
        anyChange = true;
      }
    }
    if (!anyChange) {
      // No build-log fields to touch — still stamp idempotency.
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { _timebaseScaledAt: stampedAt } },
        },
      });
    } else {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: set },
        },
      });
    }
    planned += 1;
    if (ops.length >= opts.batch) {
      written += await flushBulk(coll, ops, opts.dryRun);
    }
  }
  written += await flushBulk(coll, ops, opts.dryRun);
  return { scanned, planned, written };
}

/**
 * Rewrite the heavy ``gameDetails`` blobs. Needs the slim row's
 * ``durationSec`` for survived-sentinel handling, so we join in
 * batches by ``{userId, gameId}``.
 *
 * @param {import('mongodb').Db} db
 * @param {{dryRun:boolean, force:boolean, batch:number, user:string|null}} opts
 */
async function runGameDetails(db, opts) {
  const coll = db.collection(COLLECTIONS.GAME_DETAILS);
  const games = db.collection(COLLECTIONS.GAMES);
  if (!opts.dryRun) await ensureSnapshot(db, COLLECTIONS.GAME_DETAILS);

  /** @type {Record<string, any>} */
  const filter = {};
  if (opts.user) filter.userId = opts.user;
  if (!opts.force) filter._timebaseScaledAt = { $exists: false };

  const cursor = coll.find(filter);

  let scanned = 0;
  let planned = 0;
  let written = 0;
  /** @type {any[]} */
  const ops = [];
  const stampedAt = new Date();
  /** @type {Array<{doc: any}>} */
  const pending = [];

  /**
   * Drain ``pending`` into ``ops``, fetching durationSec for the batch
   * in a single query so survived-sentinel rewrites have the real end.
   */
  const drainPending = async () => {
    if (pending.length === 0) return;
    /** @type {Map<string, number>} */
    const durations = new Map();
    const keys = pending.map((p) => ({
      userId: p.doc.userId,
      gameId: p.doc.gameId,
    }));
    const slimCursor = games.find(
      { $or: keys },
      { projection: { _id: 0, userId: 1, gameId: 1, durationSec: 1 } },
    );
    for await (const slim of slimCursor) {
      if (!slim || !slim.userId || !slim.gameId) continue;
      const k = `${slim.userId}|${slim.gameId}`;
      durations.set(k, Number(slim.durationSec) || 0);
    }
    for (const { doc } of pending) {
      const realDurationSec =
        durations.get(`${doc.userId}|${doc.gameId}`) || 0;
      /** @type {Record<string, any>} */
      const set = { _timebaseScaledAt: stampedAt };
      let anyChange = false;
      const logFields = [
        "buildLog",
        "oppBuildLog",
        "earlyBuildLog",
        "oppEarlyBuildLog",
      ];
      for (const f of logFields) {
        const rescaled = rescaleBuildLogArray(doc[f]);
        if (rescaled) {
          set[f] = rescaled;
          anyChange = true;
        }
      }
      if (doc.macroBreakdown && typeof doc.macroBreakdown === "object") {
        set.macroBreakdown = rescaleMacroBreakdown(
          doc.macroBreakdown,
          realDurationSec,
        );
        anyChange = true;
      }
      if (doc.apmCurve && typeof doc.apmCurve === "object") {
        set.apmCurve = rescaleApmCurve(doc.apmCurve);
        anyChange = true;
      }
      if (!anyChange) {
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { _timebaseScaledAt: stampedAt } },
          },
        });
      } else {
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: set },
          },
        });
      }
      planned += 1;
    }
    pending.length = 0;
    if (ops.length >= opts.batch) {
      written += await flushBulk(coll, ops, opts.dryRun);
    }
  };

  for await (const doc of cursor) {
    scanned += 1;
    if (!opts.force && alreadyScaled(doc)) continue;
    pending.push({ doc });
    if (pending.length >= opts.batch) await drainPending();
  }
  await drainPending();
  written += await flushBulk(coll, ops, opts.dryRun);
  return { scanned, planned, written };
}

/**
 * Rewrite a customBuilds-shaped collection (customBuilds or
 * communityBuilds). Touches ``rules[*].time_lt`` and
 * ``signature[*].beforeSec``.
 *
 * @param {import('mongodb').Db} db
 * @param {string} collectionName
 * @param {{dryRun:boolean, force:boolean, batch:number, user:string|null}} opts
 */
async function runCustomShaped(db, collectionName, opts) {
  const coll = db.collection(collectionName);
  if (!opts.dryRun) await ensureSnapshot(db, collectionName);

  /** @type {Record<string, any>} */
  const filter = {};
  if (opts.user) filter.userId = opts.user;
  if (!opts.force) filter._timebaseScaledAt = { $exists: false };

  const cursor = coll.find(filter);

  let scanned = 0;
  let planned = 0;
  let written = 0;
  /** @type {any[]} */
  const ops = [];
  const stampedAt = new Date();

  for await (const doc of cursor) {
    scanned += 1;
    if (!opts.force && alreadyScaled(doc)) continue;
    const set = customBuildSetPatch(doc);
    set._timebaseScaledAt = stampedAt;
    ops.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: set } },
    });
    planned += 1;
    if (ops.length >= opts.batch) {
      written += await flushBulk(coll, ops, opts.dryRun);
    }
  }
  written += await flushBulk(coll, ops, opts.dryRun);
  return { scanned, planned, written };
}

/**
 * Drop derived-cache collections so they regenerate on next read.
 * Missing collections are a no-op. Snapshotting these would cost
 * more than just letting the read path rebuild them.
 *
 * @param {import('mongodb').Db} db
 * @param {{dryRun:boolean}} opts
 */
async function runDropDerived(db, opts) {
  let scanned = 0;
  let planned = 0;
  let written = 0;
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );
  for (const name of DERIVED_CACHE_COLLECTIONS) {
    scanned += 1;
    if (!existing.has(name)) continue;
    planned += 1;
    if (opts.dryRun) {
      console.log(`  [dry-run] would drop ${name}`);
      continue;
    }
    await db.collection(name).drop().catch(() => {});
    written += 1;
    console.log(`  dropped ${name}`);
  }
  return { scanned, planned, written };
}

function parseArgs(argv = process.argv.slice(2)) {
  /** @type {{dryRun:boolean, force:boolean, batch:number, user:string|null}} */
  const out = {
    dryRun: false,
    force: false,
    batch: DEFAULT_BATCH,
    user: null,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--batch=")) {
      const n = Number.parseInt(arg.slice("--batch=".length), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (arg.startsWith("--user=")) {
      const v = arg.slice("--user=".length).trim();
      out.user = v.length > 0 ? v : null;
    }
  }
  return out;
}

/**
 * Top-level entry that callers (tests + the CLI) share. Returns a
 * summary so tests can assert what changed.
 *
 * @param {import('mongodb').Db} db
 * @param {Partial<{dryRun:boolean, force:boolean, batch:number, user:string|null}>} [overrides]
 */
async function runMigration(db, overrides = {}) {
  const opts = {
    dryRun: false,
    force: false,
    batch: DEFAULT_BATCH,
    user: null,
    ...overrides,
  };
  const tStart = Date.now();
  const games = await step("games (slim row)", () => runGames(db, opts));
  const gameDetails = await step("gameDetails (heavy blobs)", () =>
    runGameDetails(db, opts),
  );
  const customBuilds = await step("customBuilds", () =>
    runCustomShaped(db, COLLECTIONS.CUSTOM_BUILDS, opts),
  );
  const communityBuilds = await step("communityBuilds", () =>
    runCustomShaped(db, COLLECTIONS.COMMUNITY_BUILDS, opts),
  );
  const derived = await step("derived caches (drop)", () =>
    runDropDerived(db, opts),
  );
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  if (opts.dryRun) {
    console.log(
      `\n[dry-run] would rescale ${games.planned} games, ` +
        `${gameDetails.planned} blobs, ${customBuilds.planned} custom builds, ` +
        `${communityBuilds.planned} community builds; ` +
        `would drop ${derived.planned} derived caches.`,
    );
  } else {
    console.log(`\nTotal elapsed: ${elapsed}s`);
  }
  return { games, gameDetails, customBuilds, communityBuilds, derived };
}

async function main() {
  const opts = parseArgs();
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri || !dbName) {
    console.error("MONGODB_URI and MONGODB_DB must be set in the environment.");
    process.exit(2);
  }
  if (opts.dryRun) console.log("[DRY RUN] no writes will be issued.");
  if (opts.force) console.log("[--force] _timebaseScaledAt guard disabled.");
  const client = new MongoClient(uri);
  await client.connect();
  try {
    await runMigration(client.db(dbName), opts);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  SCALE,
  SNAPSHOT_SUFFIX,
  DERIVED_CACHE_COLLECTIONS,
  rescaleSec,
  rescaleBuildLogLine,
  rescaleBuildLogArray,
  rescaleTimeKeyedArray,
  rescaleBornDiedArray,
  rescaleApmCurve,
  rescaleMacroBreakdown,
  isBrokenScaleGameLength,
  customBuildSetPatch,
  alreadyScaled,
  parseArgs,
  runMigration,
};
