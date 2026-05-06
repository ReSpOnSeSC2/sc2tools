"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { evaluateRules } = require("./buildRulesEvaluator");
const { computeDossierExtras } = require("./buildDossier");

const STATS_GAME_SCAN_CAP = 1000;
const RECENT_GAMES_LIMIT = 50;

/**
 * Custom builds service. Per-user authored builds. Stored under
 * (userId, slug) — slug is a stable client-generated id.
 *
 * NOTE: shared community-builds remain in cloud/community-builds/ —
 * this is the user's PRIVATE library, which they may publish to the
 * community DB via a separate flow.
 *
 * Rule evaluation:
 *   The /v1/builds endpoint groups stored games by `myBuild`, which
 *   only reflects what the agent classified at upload time. A custom
 *   build the user just saved has zero matching games until the agent
 *   reclassifies, leaving the BuildCard stuck on "0 games" even though
 *   the live preview pinged "1 match".
 *
 *   `evaluateBuild` and `evaluateAllStats` re-run the saved rules
 *   against the user's last N games at request time, so the library
 *   and detail views show real numbers immediately.
 */
class CustomBuildsService {
  /**
   * @param {{customBuilds: import('mongodb').Collection}} db
   * @param {{ perGame?: import('./types').PerGameComputeService }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.perGame = opts.perGame || null;
  }

  /**
   * @param {string} userId
   * @returns {Promise<object[]>}
   */
  async list(userId) {
    return this.db.customBuilds
      .find({ userId, deletedAt: { $exists: false } }, { projection: { _id: 0 } })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  /**
   * @param {string} userId
   * @param {string} slug
   */
  async get(userId, slug) {
    return this.db.customBuilds.findOne(
      { userId, slug, deletedAt: { $exists: false } },
      { projection: { _id: 0 } },
    );
  }

  /**
   * Idempotent upsert. Updates updatedAt on every write.
   *
   * @param {string} userId
   * @param {{slug: string} & Record<string, unknown>} build
   */
  async upsert(userId, build) {
    if (!build || !build.slug) throw new Error("slug required");
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = { ...build, userId, updatedAt: now };
    delete doc._id;
    delete doc.deletedAt;
    delete doc._schemaVersion;
    stampVersion(doc, COLLECTIONS.CUSTOM_BUILDS);
    await this.db.customBuilds.updateOne(
      { userId, slug: build.slug },
      { $setOnInsert: { createdAt: now }, $set: doc, $unset: { deletedAt: "" } },
      { upsert: true },
    );
  }

  /**
   * Soft-delete: keep the document so the agent's local cache can
   * reconcile, but mark it deleted so list queries skip it.
   *
   * @param {string} userId
   * @param {string} slug
   */
  async softDelete(userId, slug) {
    await this.db.customBuilds.updateOne(
      { userId, slug },
      { $set: { deletedAt: new Date() } },
    );
  }

  /**
   * Re-run a saved build's rules against the user's recent games and
   * return the same shape /v1/builds/:name uses, plus the matching
   * games per map / matchup / strategy so BuildDetailView renders the
   * standard breakdown cards. Returns null when the build doesn't
   * exist for this user.
   *
   * @param {string} userId
   * @param {string} slug
   * @returns {Promise<null | {
   *   slug: string,
   *   name: string,
   *   totals: { wins: number, losses: number, total: number, winRate: number, lastPlayed: Date|null },
   *   byMatchup: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   byMap: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   byStrategy: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   recent: Array<{gameId: string, date: string|null, map: string, opponent: string, opp_race: string, opp_strategy: string|null, result: string|null, duration: number|null}>,
   *   scannedGames: number,
   *   ruleCount: number,
   * }>}
   */
  async evaluateBuild(userId, slug) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const build = await this.get(userId, slug);
    if (!build) return null;
    const rules = extractRules(build);
    const perspective = build.perspective === "opponent" ? "opponent" : "you";
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
    });
    const inMatchup = games.filter((g) =>
      gameMatchesBuildMatchup(g, build, perspective),
    );
    const matched = filterMatchingGames(inMatchup, rules, perspective);
    const extras = computeDossierExtras(matched);
    return {
      slug: build.slug,
      name: build.name || build.slug,
      totals: rollupTotals(matched),
      byMatchup: groupRows(matched, matchupKey),
      byMap: groupRows(matched, (g) => g.map || "Unknown"),
      byStrategy: groupRows(
        matched,
        (g) => (g.opponent && g.opponent.strategy) || "Unknown",
      ),
      recent: matched.slice(0, RECENT_GAMES_LIMIT).map(toRecent),
      scannedGames: games.length,
      ruleCount: rules.length,
      ...extras,
    };
  }

  /**
   * Aggregate stats for every saved build the user owns. One scan over
   * the user's recent games, evaluating every build's rules per game.
   * The returned rows match `/v1/builds` row shape so the existing
   * `decorateBuilds` UI code works unchanged.
   *
   * @param {string} userId
   * @returns {Promise<Array<{name: string, slug: string, total: number, wins: number, losses: number, winRate: number, lastPlayed: Date|null, ruleCount: number}>>}
   */
  async evaluateAllStats(userId) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const builds = await this.list(userId);
    if (builds.length === 0) return [];
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
    });
    return builds.map(
      /** @param {any} b */ (b) => {
        const rules = extractRules(b);
        const perspective = b.perspective === "opponent" ? "opponent" : "you";
        const inMatchup = games.filter((g) =>
          gameMatchesBuildMatchup(g, b, perspective),
        );
        const matched =
          rules.length === 0
            ? []
            : filterMatchingGames(inMatchup, rules, perspective);
        const t = rollupTotals(matched);
        return {
          name: b.name || b.slug,
          slug: b.slug,
          total: t.total,
          wins: t.wins,
          losses: t.losses,
          winRate: t.winRate,
          lastPlayed: t.lastPlayed,
          ruleCount: rules.length,
        };
      },
    );
  }
}

/**
 * Pull a v3-shaped rules array from the saved build, falling back to
 * an empty list when neither rules nor a usable signature is present.
 * v2 signatures (unit/count/beforeSec) are converted to count_min
 * rules so old saved builds still match.
 *
 * @param {any} build
 * @returns {Array<{type: string, name: string, time_lt: number, count?: number}>}
 */
function extractRules(build) {
  if (Array.isArray(build.rules) && build.rules.length > 0) {
    return build.rules.filter((r) => r && typeof r === "object" && r.name);
  }
  if (Array.isArray(build.signature) && build.signature.length > 0) {
    return build.signature
      .filter((s) => s && typeof s === "object" && typeof s.unit === "string")
      .map((s) => ({
        type: "count_min",
        name: ruleNameFromUnit(s.unit),
        time_lt: Math.max(1, Number(s.beforeSec) || 60),
        count: Math.max(1, Number(s.count) || 1),
      }));
  }
  return [];
}

/**
 * Convert a free-form unit/building label into the canonical
 * eventToken form (e.g. "Stargate" → "BuildStargate"). Mirrors the
 * fallback in buildRulesEvaluator.eventToken.
 *
 * @param {string} raw
 */
function ruleNameFromUnit(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^(Build|Train|Research|Morph)[A-Z]/.test(trimmed)) return trimmed;
  const noun = trimmed.replace(/[^A-Za-z0-9]/g, "");
  if (!noun) return "";
  return "Build" + noun.charAt(0).toUpperCase() + noun.slice(1);
}

/**
 * Strict matchup gate. A saved build with a single-matchup target
 * (e.g. PvP, PvT) must only count games where both sides line up;
 * otherwise the build silently absorbs cross-matchup replays and
 * Top-matchups / Recent-games / Vs-strategy all show wrong rows.
 *
 * Semantics:
 *   - vsRace omitted or "Any" → opponent side is unconstrained.
 *   - From perspective="you", race is the user's race and vsRace is the
 *     opponent's race (compared to g.myRace / g.oppRace).
 *   - From perspective="opponent", the build describes what the opponent
 *     ran, so race is the opponent's race and vsRace is the user's race
 *     (sides flipped).
 *   - When the game has no race recorded (legacy import), fall back to
 *     the "PvT — …" prefix on g.myBuild; if neither is available we
 *     drop the game from the bucket. The previous permissive behavior
 *     in the live preview let unverifiable replays leak in, which is
 *     exactly what produced PvT games on a PvP build.
 *
 * @param {{myRace: string|null, oppRace: string|null, myBuild?: string|null}} g
 * @param {any} build
 * @param {'you'|'opponent'} perspective
 * @returns {boolean}
 */
function gameMatchesBuildMatchup(g, build, perspective) {
  const mySideActual = perspective === "opponent" ? g.oppRace : g.myRace;
  const oppSideActual = perspective === "opponent" ? g.myRace : g.oppRace;
  const myBucketPos = perspective === "opponent" ? 2 : 0;
  const oppBucketPos = perspective === "opponent" ? 0 : 2;
  return (
    raceStrictMatch(mySideActual, build && build.race, g.myBuild, myBucketPos) &&
    raceStrictMatch(
      oppSideActual,
      build && build.vsRace,
      g.myBuild,
      oppBucketPos,
    )
  );
}

/**
 * @param {string|null|undefined} actual
 * @param {string|undefined} requested
 * @param {string|null|undefined} buildName
 * @param {number} bucketPos
 * @returns {boolean}
 */
function raceStrictMatch(actual, requested, buildName, bucketPos) {
  if (!requested || requested === "Any") return true;
  const r = requested.charAt(0).toUpperCase();
  if (actual) return actual.charAt(0).toUpperCase() === r;
  if (typeof buildName === "string" && /^[PTZ]v[PTZ]/.test(buildName)) {
    return buildName.charAt(bucketPos) === r;
  }
  return false;
}

/**
 * @param {Array<{events: any[], oppEvents: any[], myRace: string|null, oppRace: string|null, gameId: string, result: string|null, date: Date|null, map: string|null}>} games
 * @param {ReadonlyArray<{type: string, name: string, time_lt: number, count?: number}>} rules
 * @param {'you'|'opponent'} perspective
 */
function filterMatchingGames(games, rules, perspective) {
  if (rules.length === 0) return [];
  /** @type {any[]} */
  const out = [];
  for (const g of games) {
    const events =
      perspective === "opponent" ? g.oppEvents || [] : g.events || [];
    if (events.length === 0) continue;
    let res;
    try {
      res = evaluateRules(rules, events);
    } catch (_e) {
      continue;
    }
    if (res.pass) out.push(g);
  }
  return out;
}

/**
 * @param {Array<{result: string|null, date: Date|null}>} games
 * @returns {{wins: number, losses: number, total: number, winRate: number, lastPlayed: Date|null}}
 */
function rollupTotals(games) {
  let wins = 0;
  let losses = 0;
  let last = null;
  for (const g of games) {
    if (isWin(g.result)) wins++;
    else if (isLoss(g.result)) losses++;
    if (g.date && (!last || g.date > last)) last = g.date;
  }
  const total = games.length;
  const decided = wins + losses;
  return {
    wins,
    losses,
    total,
    winRate: decided > 0 ? wins / decided : 0,
    lastPlayed: last,
  };
}

/**
 * @template T
 * @param {Array<{result: string|null}>} games
 * @param {(g: any) => string} keyFn
 */
function groupRows(games, keyFn) {
  /** @type {Map<string, {wins: number, losses: number, total: number}>} */
  const buckets = new Map();
  for (const g of games) {
    const key = (keyFn(g) || "Unknown").trim() || "Unknown";
    const cur = buckets.get(key) || { wins: 0, losses: 0, total: 0 };
    cur.total += 1;
    if (isWin(g.result)) cur.wins += 1;
    else if (isLoss(g.result)) cur.losses += 1;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .map(([name, v]) => {
      const decided = v.wins + v.losses;
      return {
        name,
        wins: v.wins,
        losses: v.losses,
        total: v.total,
        winRate: decided > 0 ? v.wins / decided : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** @param {{myRace: string|null, oppRace: string|null}} g */
function matchupKey(g) {
  const my = (g.myRace || "?").charAt(0).toUpperCase() || "?";
  const opp = (g.oppRace || "?").charAt(0).toUpperCase() || "?";
  return `${my}v${opp}`;
}

/** @param {string|null} r */
function isWin(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "win" || s === "victory";
}

/** @param {string|null} r */
function isLoss(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "loss" || s === "defeat";
}

/** @param {any} g */
function toRecent(g) {
  return {
    gameId: g.gameId,
    date: g.date instanceof Date ? g.date.toISOString() : g.date,
    map: g.map || "",
    opponent: (g.opponent && g.opponent.displayName) || "",
    opp_race: g.oppRace || (g.opponent && g.opponent.race) || "",
    opp_strategy: (g.opponent && g.opponent.strategy) || null,
    result: g.result || null,
    duration: g.durationSec != null ? g.durationSec : null,
    macroScore: typeof g.macroScore === "number" ? g.macroScore : null,
  };
}

module.exports = { CustomBuildsService };
