"use strict";

const { attachOpponentIdsToFilter } = require("../util/opponentIdentity");
const {
  computeCompositions,
  prepareCompositionGame,
} = require("./buildCompositions");
const { computePerGameScouting } = require("./scouting/perGameScouting");
const {
  compactAnalysisBuildLog,
  compactAnalysisMacroBreakdown,
} = require("./boundedReplayDetail");

/**
 * Cap on the number of recent games we run the phase classifier over
 * when deriving ``opponentPhases``. This runs on every pre-game wake-
 * up (the 1 Hz envelope cadence is cached, but the first envelope of
 * each new gameKey bypasses the cache) so the upper bound matters —
 * 50 is enough to give the modal final-phase and the trajectory
 * medians a stable signal while keeping the detail-store work bounded.
 */
const OPPONENT_PHASE_SCAN_CAP = 50;
const OVERLAY_DETAIL_FIELDS = Object.freeze([
  "buildLog",
  "oppBuildLog",
  "macroBreakdown",
]);

/** @type {ReadonlyArray<'early'|'earlyMid'|'mid'|'midLate'|'late'>} */
const PHASE_ORDER = ["early", "earlyMid", "mid", "midLate", "late"];

/**
 * Mongo-aggregation helpers backing the OverlayLiveService.
 *
 * Extracted from ``overlayLive.js`` to keep that file under the
 * project's 800-line ceiling. Each function takes the games /
 * opponents collections explicitly so the helpers stay testable in
 * isolation; the ``OverlayLiveService`` class methods remain the
 * public surface and delegate here.
 *
 * The aggregations themselves are unchanged — same pipelines, same
 * projections, same identity-precedence rules.
 */

/**
 * Normalise a stored result string ("Victory"/"Defeat"/"Win"/"Loss",
 * any casing) into the win/loss buckets the widgets consume.
 *
 * @param {unknown} raw
 * @returns {'win'|'loss'|null}
 */
function bucketResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "win";
  if (s === "loss" || s === "defeat") return "loss";
  return null;
}

/**
 * Format a duration in seconds as `m:ss`. Matches the SPA's
 * `formatMatchDuration` for the scouting card's recent-games list.
 *
 * @param {number} sec
 * @returns {string}
 */
function formatLengthText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Title-case an internal result tag for the scouting widget's chip
 * text. The SPA stored "Win" / "Loss" / "Tie" — we map the cloud's
 * "Victory" / "Defeat" to those so the widget can stay rendering-only.
 *
 * @param {string|undefined|null} raw
 * @returns {"Win"|"Loss"|"Tie"|null}
 */
function chipResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "Win";
  if (s === "loss" || s === "defeat") return "Loss";
  if (s === "tie") return "Tie";
  return null;
}

/** @param {unknown} s @returns {string} */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk the most recent games and report the current win/loss run.
 * Returns null when the streak count is below 3 — the widget hides
 * itself anyway, no point pushing a payload it'll discard.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @returns {Promise<{kind: 'win'|'loss', count: number} | null>}
 */
async function computeStreak(games, userId) {
  const recent = await games
    .find(
      { userId, isResumedFromReplay: { $ne: true } },
      { projection: { _id: 0, result: 1, date: 1 } },
    )
    .sort({ date: -1 })
    .limit(20)
    .toArray()
    .catch(() => []);
  if (recent.length === 0) return null;
  /** @type {'win'|'loss'|null} */
  let kind = null;
  let count = 0;
  for (const r of recent) {
    const b = bucketResult(r.result);
    if (!b) continue;
    if (kind === null) {
      kind = b;
      count = 1;
      continue;
    }
    if (b !== kind) break;
    count += 1;
  }
  if (kind && count >= 3) return { kind, count };
  return null;
}

/**
 * Find the most recently dated game (other than ``excludeGameId``)
 * for this user that carries a comparable ``myMmr``. Used to compute
 * the MMR delta for the just-uploaded game.
 *
 * "Comparable" means the pair would chain in the trends net-MMR
 * pipeline too (see trendsRegionExpr): replay-verified rating, same
 * Battle.net account, same ladder race. Without those gates a
 * streamer finishing an EU-main game and then playing one game on a
 * lower-MMR NA smurf — or switching from Zerg ladder to Random —
 * would flash a giant fake "−1500" on stream.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} [excludeGameId]
 * @param {Date|string} [beforeDate]
 * @param {{ myToonHandle?: unknown, ladderRace?: unknown }} [context]
 *   Identity of the just-uploaded game. When the handle / race are
 *   present, the previous game must match them; a missing handle
 *   (very old agent) keeps the legacy same-user-only behaviour.
 * @returns {Promise<number|null>}
 */
async function previousGameMmr(games, userId, excludeGameId, beforeDate, context = {}) {
  /** @type {Record<string, any>} */
  const filter = {
    userId,
    isResumedFromReplay: { $ne: true },
    myMmr: { $type: "number" },
    // Only replay-verified ratings may anchor a delta — quarantined
    // legacy numerics (retired current-Pulse pollution) are excluded
    // here exactly as they are in the analyzer's MMR charts.
    myMmrSource: "replay",
  };
  if (excludeGameId) filter.gameId = { $ne: excludeGameId };
  if (beforeDate) {
    const d = beforeDate instanceof Date ? beforeDate : new Date(beforeDate);
    if (!Number.isNaN(d.getTime())) filter.date = { $lte: d };
  }
  const handle =
    typeof context.myToonHandle === "string" ? context.myToonHandle.trim() : "";
  if (handle) filter.myToonHandle = handle;
  const raceHead = String(context.ladderRace || "").trim().charAt(0).toUpperCase();
  if (["P", "T", "Z", "R"].includes(raceHead)) {
    // Compare ladder races by their leading letter, falling back to
    // the spawned race for rows that pre-date myLadderRace — the same
    // derivation the trends pipeline uses (myLadderRaceExpr).
    filter.$expr = {
      $eq: [
        {
          $toUpper: {
            $substrCP: [
              { $ifNull: ["$myLadderRace", { $ifNull: ["$myRace", ""] }] },
              0,
              1,
            ],
          },
        },
        raceHead,
      ],
    };
  }
  const prev = await games
    .find(filter, { projection: { _id: 0, myMmr: 1, date: 1 } })
    .sort({ date: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  if (prev.length === 0) return null;
  const m = Number(prev[0].myMmr);
  return Number.isFinite(m) ? m : null;
}

/**
 * Last N games against this opponent in this matchup, newest first.
 * Excludes the just-uploaded game so the scouting widget shows
 * *prior* meetings — the current game is what the streamer is about
 * to play, surfaced through the match-result/post-game widgets.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {Record<string, any>} opp
 * @param {string|undefined} myRace
 * @param {string|undefined} oppRace
 * @param {string|undefined} excludeGameId
 */
async function recentGamesForOpponent(games, userId, opp, myRace, oppRace, excludeGameId) {
  if (!opp) return [];
  /** @type {Record<string, any>} */
  const filter = { userId, isResumedFromReplay: { $ne: true } };
  const attached = attachOpponentIdsToFilter(filter, {
    pulseId: opp.pulseId,
    pulseCharacterId: opp.pulseCharacterId,
  });
  if (!attached) {
    if (opp.displayName) {
      filter["opponent.displayName"] = opp.displayName;
    } else {
      return [];
    }
  }
  if (excludeGameId) filter.gameId = { $ne: excludeGameId };
  if (myRace) {
    filter.myRace = { $regex: `^${escapeRegex(String(myRace).charAt(0))}`, $options: "i" };
  }
  if (oppRace) {
    filter["opponent.race"] = {
      $regex: `^${escapeRegex(String(oppRace).charAt(0))}`,
      $options: "i",
    };
  }
  const rows = await games
    .find(filter, {
      projection: {
        _id: 0,
        result: 1,
        durationSec: 1,
        map: 1,
        myBuild: 1,
        "opponent.strategy": 1,
        "opponent.race": 1,
        date: 1,
      },
    })
    .sort({ date: -1 })
    .limit(5)
    .toArray()
    .catch(() => []);
  /** @type {Array<{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}>} */
  const out = [];
  for (const r of rows) {
    const chip = chipResult(r.result);
    if (!chip) continue;
    /** @type {{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}} */
    const row = {
      result: chip,
      lengthText: formatLengthText(Number(r.durationSec) || 0),
    };
    if (r.map) row.map = String(r.map);
    if (r.myBuild) row.myBuild = String(r.myBuild);
    if (r.opponent && r.opponent.strategy) row.oppBuild = String(r.opponent.strategy);
    if (r.opponent && r.opponent.race) row.oppRace = String(r.opponent.race);
    if (r.date instanceof Date) row.date = r.date.toISOString();
    else if (typeof r.date === "string") row.date = r.date;
    out.push(row);
  }
  return out;
}

/**
 * Top ``myBuild`` rows for a matchup, sorted by total games.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 */
async function topBuildsForMatchup(games, userId, myRace, oppRace) {
  if (!myRace || !oppRace) return [];
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        isResumedFromReplay: { $ne: true },
        myBuild: { $type: "string", $ne: "" },
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$myBuild",
        wins: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
              1,
              0,
            ],
          },
        },
        total: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 3 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  return rows.map((r) => ({
    name: String(r._id),
    total: r.total || 0,
    winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
  }));
}

/**
 * Streamer's best ``myBuild`` against a specific opponent strategy
 * inside a matchup. Used by the "Best Answer" widget.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 * @param {string} strategy
 */
async function bestAnswerVsStrategy(games, userId, myRace, oppRace, strategy) {
  if (!strategy) return null;
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        isResumedFromReplay: { $ne: true },
        myBuild: { $type: "string", $ne: "" },
        "opponent.strategy": strategy,
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$myBuild",
        wins: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
              1,
              0,
            ],
          },
        },
        total: { $sum: 1 },
      },
    },
    // 3-game floor protects against "100% in a 1-game sample" noise.
    { $match: { total: { $gte: 3 } } },
    { $sort: { wins: -1, total: -1 } },
    { $limit: 1 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    build: String(r._id),
    total: r.total || 0,
    winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
  };
}

/**
 * Top opening shares (by share-of-encounters) the streamer has seen
 * from opponents in this matchup. Used by the "Meta snapshot" widget.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 */
async function metaForMatchup(games, userId, myRace, oppRace) {
  if (!myRace || !oppRace) return [];
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        isResumedFromReplay: { $ne: true },
        "opponent.strategy": { $type: "string", $ne: "" },
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    { $group: { _id: "$opponent.strategy", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  if (rows.length === 0) return [];
  const total = rows.reduce((acc, r) => acc + (r.count || 0), 0);
  if (total === 0) return [];
  return rows.map((r) => ({
    name: String(r._id),
    share: (r.count || 0) / total,
  }));
}

/**
 * Read one projected detail object. Mongo can honor the field projection
 * before materializing the row; R2 still parses one object, but never holds a
 * multi-game batch or fans out concurrent reads from a 1 Hz overlay request.
 * @param {import('./gameDetails').GameDetailsService|null} gameDetails
 * @param {string} userId
 * @param {string} gameId
 * @param {ReadonlyArray<string>} fields
 */
async function readOneOverlayDetail(gameDetails, userId, gameId, fields) {
  if (!gameDetails || !gameId) return null;
  try {
    if (typeof gameDetails.findMany === "function") {
      const one = await gameDetails.findMany(userId, [gameId], {
        fields: [...fields],
        concurrency: 1,
        tolerateCorruptObjects: true,
      });
      return one.get(gameId) || null;
    }
    if (typeof gameDetails.findOne === "function") {
      const raw = await gameDetails.findOne(userId, gameId);
      if (!raw || typeof raw !== "object") return null;
      return Object.fromEntries(
        fields.filter((field) => raw[field] !== undefined)
          .map((field) => [field, raw[field]]),
      );
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Phase forecast for the scouting card's "Usually reaches Mid/Late"
 * strip. Pulls up to ``OPPONENT_PHASE_SCAN_CAP`` of the streamer's
 * recent games against this opponent in this matchup, hydrates
 * ``macroBreakdown`` from the detail store, then hands the matched
 * set to ``computeCompositions`` to derive the same trajectory shape
 * the BuildDossier / StrategyPhasesPanel render — re-using exactly
 * one piece of compute logic across every phase-aware UI in the app.
 *
 * Returns ``null`` when the opponent is too sparse (< 3 games with
 * usable ``macroBreakdown``). The renderer treats null as "render
 * nothing in this slot" — better silent than wrong on stream.
 *
 * @param {import('mongodb').Collection} games
 * @param {import('./gameDetails').GameDetailsService|null} gameDetails
 * @param {string} userId
 * @param {Record<string, any>} opp
 * @param {string|undefined} myRace
 * @param {string|undefined} oppRace
 * @returns {Promise<null | {
 *   typicalFinalPhase: 'early'|'earlyMid'|'mid'|'midLate'|'late',
 *   trajectory: {
 *     sampleSize: Record<string, number>,
 *     crossings: { earlyMidAt: number|null, midAt: number|null, midLateAt: number|null, lateAt: number|null },
 *     finalPhaseDistribution: Record<string, number>,
 *     durationP95Sec: number,
 *   },
 *   typicalLateComp?: { units: string[], sampleCount: number, winRate: number },
 * }>}
 */
async function opponentPhaseProfile(games, gameDetails, userId, opp, myRace, oppRace) {
  if (!opp) return null;
  /** @type {Record<string, any>} */
  const filter = { userId, isResumedFromReplay: { $ne: true } };
  const attached = attachOpponentIdsToFilter(filter, {
    pulseId: opp.pulseId,
    pulseCharacterId: opp.pulseCharacterId,
  });
  if (!attached) {
    if (opp.displayName) {
      filter["opponent.displayName"] = opp.displayName;
    } else {
      return null;
    }
  }
  if (myRace) {
    filter.myRace = { $regex: `^${escapeRegex(String(myRace).charAt(0))}`, $options: "i" };
  }
  if (oppRace) {
    filter["opponent.race"] = {
      $regex: `^${escapeRegex(String(oppRace).charAt(0))}`,
      $options: "i",
    };
  }
  // Metadata only. Detail-store data (or a one-row legacy inline fallback) is
  // read serially below and immediately reduced to a prepared phase summary.
  const rows = await games
    .find(filter, {
      projection: {
        _id: 1,
        gameId: 1,
        result: 1,
        durationSec: 1,
        myRace: 1,
      },
    })
    .sort({ date: -1 })
    .limit(OPPONENT_PHASE_SCAN_CAP)
    .toArray()
    .catch(() => []);
  if (rows.length === 0) return null;

  const matched = [];
  for (const r of rows) {
    const gameId = String(r.gameId || "");
    const detail = await readOneOverlayDetail(
      gameDetails,
      userId,
      gameId,
      ["macroBreakdown"],
    );
    const inline = !detail?.macroBreakdown && !r.macroBreakdown && r._id
      ? await games.findOne(
          { userId, _id: r._id },
          { projection: { _id: 0, macroBreakdown: 1 } },
        ).catch(() => null)
      : null;
    const rawMacro = detail?.macroBreakdown
      || r.macroBreakdown
      || inline?.macroBreakdown
      || null;
    if (!rawMacro) continue;
    const base = {
      gameId,
      myRace: r.myRace || myRace || null,
      durationSec: Number(r.durationSec) || 0,
      result: r.result || null,
    };
    let prepared;
    try {
      prepared = prepareCompositionGame({
        ...base,
        macroBreakdown: compactAnalysisMacroBreakdown(rawMacro),
      });
    } catch {
      continue;
    }
    matched.push({
      ...base,
      _phasePrepared: prepared,
    });
  }
  // 3-game floor mirrors the rival-tag threshold and the best-answer
  // sample floor — fewer than that and any modal phase is noise.
  if (matched.length < 3) return null;

  const comps = computeCompositions(matched);

  /** @type {'early'|'earlyMid'|'mid'|'midLate'|'late'} */
  let typicalFinalPhase = "early";
  let topCount = -1;
  for (const phase of PHASE_ORDER) {
    const c = comps.finalPhaseDistribution[phase] || 0;
    if (c > topCount) {
      topCount = c;
      typicalFinalPhase = phase;
    }
  }
  if (topCount <= 0) return null;

  const trajectory = {
    sampleSize: comps.sampleSize,
    crossings: comps.medianCrossings,
    finalPhaseDistribution: comps.finalPhaseDistribution,
    durationP95Sec: comps.durationP95Sec,
  };

  /** @type {{ units: string[], sampleCount: number, winRate: number } | undefined} */
  let typicalLateComp;
  const reachesMidPlus = PHASE_ORDER.indexOf(typicalFinalPhase) >= PHASE_ORDER.indexOf("mid");
  if (reachesMidPlus) {
    // Pick the deepest phase the games actually reached and surface
    // its top signature. Walk from "late" → "mid" so a build that
    // mostly ends in midLate still surfaces the midLate signature
    // rather than falling silent because "late" had zero samples.
    const phasePreference = ["late", "midLate", "mid"];
    for (const phase of phasePreference) {
      const row = comps.perPhase && comps.perPhase[phase];
      const sigs = row && Array.isArray(row.signatures) ? row.signatures : [];
      const top = sigs.find((s) => s.key !== "Other" && s.units && s.units.length > 0);
      if (top) {
        typicalLateComp = {
          // Signature rows come out of ``finalizeSignatures`` in
          // buildCompositions.js with this exact units shape.
          units: /** @type {Array<{token: string, count: number}>} */ (
            top.units
          ).map((u) => u.token),
          sampleCount: top.sampleCount || 0,
          winRate: typeof top.winRate === "number" ? top.winRate : 0,
        };
        break;
      }
    }
  }

  /** @type {{
   *   typicalFinalPhase: 'early'|'earlyMid'|'mid'|'midLate'|'late',
   *   trajectory: {
   *     sampleSize: Record<string, number>,
   *     crossings: { earlyMidAt: number|null, midAt: number|null, midLateAt: number|null, lateAt: number|null },
   *     finalPhaseDistribution: Record<string, number>,
   *     durationP95Sec: number,
   *   },
   *   typicalLateComp?: { units: string[], sampleCount: number, winRate: number },
   * }} */
  const out = { typicalFinalPhase, trajectory };
  if (typicalLateComp) out.typicalLateComp = typicalLateComp;
  return out;
}

/**
 * Per-game scouting envelopes for the last 5 games against this
 * opponent. Drives the overlay's scouting widget's "Last 5 games"
 * block — real build-order events + phase transitions +
 * composition-by-phase snapshots from real games (no medians, no
 * fabricated data).
 *
 * Returns the array sorted newest-first to match the widget's
 * top-to-bottom render order. Empty when no games match.
 *
 * @param {import('mongodb').Collection} games
 * @param {import('./gameDetails').GameDetailsService | null} gameDetails
 * @param {string} userId
 * @param {Record<string, any>} opp
 * @param {string|undefined} myRace
 * @param {string|undefined} oppRace
 * @returns {Promise<Array<object>>}
 */
async function last5GamesScouting(games, gameDetails, userId, opp, myRace, oppRace) {
  if (!opp) return [];
  /** @type {Record<string, any>} */
  const filter = { userId, isResumedFromReplay: { $ne: true } };
  const attached = attachOpponentIdsToFilter(filter, {
    pulseId: opp.pulseId,
    pulseCharacterId: opp.pulseCharacterId,
  });
  if (!attached) {
    if (opp.displayName) {
      filter["opponent.displayName"] = opp.displayName;
    } else {
      return [];
    }
  }
  if (myRace) {
    filter.myRace = { $regex: `^${escapeRegex(String(myRace).charAt(0))}`, $options: "i" };
  }
  if (oppRace) {
    filter["opponent.race"] = {
      $regex: `^${escapeRegex(String(oppRace).charAt(0))}`,
      $options: "i",
    };
  }
  const rows = await games
    .find(filter, {
      projection: {
        _id: 1,
        gameId: 1,
        date: 1,
        result: 1,
        map: 1,
        myRace: 1,
        myBuild: 1,
        durationSec: 1,
        "opponent.displayName": 1,
        "opponent.race": 1,
        "opponent.strategy": 1,
      },
    })
    .sort({ date: -1 })
    .limit(5)
    .toArray()
    .catch(() => []);
  if (rows.length === 0) return [];
  // Hydrate one row at a time and immediately reduce it to the bounded
  // scouting response. This preserves both sides' build-order/composition
  // fields without retaining five raw replay blobs at once.
  /** @type {Array<object>} */
  const envelopes = [];
  for (const r of rows) {
    const gameId = String(r.gameId || "");
    const detail = await readOneOverlayDetail(
      gameDetails,
      userId,
      gameId,
      OVERLAY_DETAIL_FIELDS,
    );
    const needsInline = (
      !Array.isArray(detail?.buildLog) && !Array.isArray(r.buildLog)
    ) || (
      !Array.isArray(detail?.oppBuildLog) && !Array.isArray(r.oppBuildLog)
    ) || (!detail?.macroBreakdown && !r.macroBreakdown);
    const inline = needsInline && r._id
      ? await games.findOne(
          { userId, _id: r._id },
          {
            projection: {
              _id: 0,
              buildLog: 1,
              oppBuildLog: 1,
              macroBreakdown: 1,
            },
          },
        ).catch(() => null)
      : null;
    const hydrated = {
      gameId,
      date: r.date,
      result: r.result,
      map: r.map,
      myRace: r.myRace,
      myBuild: r.myBuild,
      durationSec: r.durationSec,
      opponent: r.opponent,
      buildLog: compactAnalysisBuildLog(
        detail?.buildLog ?? r.buildLog ?? inline?.buildLog,
      ),
      oppBuildLog: compactAnalysisBuildLog(
        detail?.oppBuildLog ?? r.oppBuildLog ?? inline?.oppBuildLog,
      ),
      macroBreakdown: compactAnalysisMacroBreakdown(
        detail?.macroBreakdown ?? r.macroBreakdown ?? inline?.macroBreakdown,
      ),
    };
    try {
      const env = computePerGameScouting(hydrated);
      // Strip the heavy ``macroBreakdown`` blob if the compute kept any
      // reference (it doesn't — it copies the fields it needs — but
      // defensive against future regressions).
      envelopes.push(env);
    } catch (err) {
      console.warn(
        "last5GamesScouting: skipping gameId=%s userId=%s: %s",
        r && r.gameId, userId,
        (err && /** @type {{ message?: unknown }} */ (err).message) || err,
      );
    }
  }
  return envelopes;
}

module.exports = {
  bucketResult,
  chipResult,
  formatLengthText,
  escapeRegex,
  computeStreak,
  previousGameMmr,
  recentGamesForOpponent,
  topBuildsForMatchup,
  bestAnswerVsStrategy,
  metaForMatchup,
  opponentPhaseProfile,
  last5GamesScouting,
  OPPONENT_PHASE_SCAN_CAP,
};
