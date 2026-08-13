"use strict";

const { CommunityService } = require("./community");
const { AggregationsService } = require("./aggregations");
const { BuildsService } = require("./builds");

/**
 * Handle format: our internal user id (a UUID) is the shareable handle.
 * Reusing the internal id (never the Clerk id — see UsersService) keeps
 * the public page decoupled from the auth provider and means the URL is
 * the same stable identifier the community author page already uses.
 * We still hard-validate the shape before touching Mongo: this endpoint
 * is unauthenticated, so a raw ``:handle`` from the URL is hostile input.
 */
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A "signature build" needs at least this many games to be meaningful
 *  (a 1-0 build isn't a signature). Below this we drop it entirely. */
const SIGNATURE_MIN_GAMES = 3;

/** How many signature builds to surface, most-played first. */
const SIGNATURE_LIMIT = 5;

/** Cap on how many matchup splits we emit (there are only ~4 real ones,
 *  but the cap guards against a corrupt row producing a runaway list). */
const MATCHUP_LIMIT = 8;

/** @type {Readonly<Record<string, string>>} */
const LETTER_TO_RACE = Object.freeze({
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
  R: "Random",
});

/**
 * PublicProfileService — powers the opt-in public player page at
 * ``/p/:handle`` (SSR) via ``GET /v1/public/profile/:handle``.
 *
 * OPT-IN MODEL (deliberately reuses existing state, adds none):
 *   A user has a public profile **iff** they have published at least one
 *   community build carrying a non-empty public ``authorName`` — exactly
 *   the gate {@link CommunityService.getAuthor} already enforces. Setting
 *   a public display name on a published build is an affirmative,
 *   user-initiated act of going public, so we treat it as the single
 *   opt-in signal rather than minting a new ``publicProfileEnabled`` flag
 *   (which would need its own settings toggle + GDPR wiring). Users who
 *   never publish under a name stay private → the route 404s.
 *
 * WHAT WE EXPOSE (non-sensitive aggregates only):
 *   - the chosen public display name + main race
 *   - headline totals (games, W-L, win rate) over the user's OWN games
 *   - matchup splits (vs P / T / Z / Unknown — race letters, not people)
 *   - a few signature builds (the user's own build labels) with win rate
 *   - one featured community build (already public) for the share loop
 *
 * WHAT WE NEVER EXPOSE:
 *   - opponent identities (battle tags, display names, pulse ids)
 *   - raw per-game rows
 *   - any other user's data
 *   The aggregate methods we reuse return opponent display names on their
 *   ``recent`` arrays — we deliberately read ONLY their totals / grouped
 *   splits and drop everything else, so no per-game identity can leak.
 */
class PublicProfileService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   community?: CommunityService,
   *   aggregations?: AggregationsService,
   *   builds?: BuildsService,
   * }} [opts]
   *   The three read services are injected so we REUSE the existing
   *   aggregators (community opt-in + author identity, headline totals /
   *   matchup splits, per-build win rates) rather than recomputing from
   *   raw games. They default-construct from ``db`` when omitted so the
   *   service also works standalone.
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.community = (opts && opts.community) || new CommunityService(db);
    this.aggregations =
      (opts && opts.aggregations) || new AggregationsService(db);
    this.builds = (opts && opts.builds) || new BuildsService(db);
  }

  /**
   * Resolve a public profile for ``handle``.
   *
   * @param {string} handle internal user id (UUID)
   * @returns {Promise<{
   *   handle: string,
   *   displayName: string,
   *   mainRace: string | null,
   *   joinedAt: Date | null,
   *   totals: { games: number, wins: number, losses: number, winRate: number },
   *   matchups: Array<{ matchup: string, games: number, wins: number, losses: number, winRate: number }>,
   *   signatureBuilds: Array<{ name: string, games: number, wins: number, losses: number, winRate: number }>,
   *   featuredBuild: { slug: string, title: string, matchup: string | null, votes: number } | null,
   *   publishedBuildCount: number,
   * } | null>}
   *   ``null`` when the handle is malformed, unknown, or the user has not
   *   opted in — the route turns every ``null`` into a neutral 404 so a
   *   deliberately-private user is never distinguishable from a missing
   *   one.
   */
  async getPublicProfile(handle) {
    if (typeof handle !== "string" || !HANDLE_RE.test(handle)) {
      return null;
    }
    const userId = handle;

    // Opt-in gate. getAuthor returns null unless the user has at least
    // one published build with a public authorName — that's the entire
    // consent check. Everything below only runs for opted-in users.
    const author = await this.community.getAuthor(userId);
    if (!author) return null;

    // Headline totals + matchup splits come from the user's own games,
    // reusing the analytics summary. We intentionally read ONLY
    // ``totals`` and ``byMatchup`` — ``summary.recent`` carries opponent
    // display names, which must never surface on a public page.
    const [summary, buildRows, mainRace] = await Promise.all([
      this.aggregations.summary(userId, {}),
      this.builds.list(userId, {}),
      this._mainRace(userId),
    ]);

    const totals = shapeTotals(summary && summary.totals);
    const matchups = shapeMatchups(summary && summary.byMatchup);
    const signatureBuilds = shapeSignatureBuilds(buildRows);
    const featuredBuild = shapeFeaturedBuild(author.topBuild);

    return {
      handle: userId,
      displayName: author.displayName,
      // Prefer the games-derived race (what they actually play); fall
      // back to the published-build dominance race from the author
      // aggregate; null → the page renders "Mixed".
      mainRace: mainRace || author.primaryRace || null,
      joinedAt: author.joinedAt || null,
      totals,
      matchups,
      signatureBuilds,
      featuredBuild,
      publishedBuildCount: Number.isFinite(author.totalBuilds)
        ? author.totalBuilds
        : 0,
    };
  }

  /**
   * Most-played race across the user's games, as a full race name.
   * A single grouped count — cheap, and gives an accurate "main race"
   * for the player card (the author aggregate's ``primaryRace`` is
   * derived from published-build metadata and is often null for players
   * who publish across matchups).
   *
   * @private
   * @param {string} userId
   * @returns {Promise<string | null>}
   */
  async _mainRace(userId) {
    const rows = await this.db.games
      .aggregate([
        {
          $match: {
            userId,
            isResumedFromReplay: { $ne: true },
            myRace: { $type: "string", $ne: "" },
          },
        },
        {
          $group: {
            _id: { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
            n: { $sum: 1 },
          },
        },
        { $sort: { n: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    const letter = rows && rows[0] ? rows[0]._id : null;
    return (letter && LETTER_TO_RACE[letter]) || null;
  }
}

// ---------------- response shaping ----------------

/**
 * @param {{wins?: number, losses?: number, total?: number, winRate?: number} | null | undefined} t
 */
function shapeTotals(t) {
  const wins = intOf(t && t.wins);
  const losses = intOf(t && t.losses);
  const games = intOf(t && t.total);
  const decided = wins + losses;
  return {
    games,
    wins,
    losses,
    // Win rate over decided games (wins / (wins + losses)) so a run of
    // ties doesn't quietly drag the headline number down.
    winRate: decided > 0 ? wins / decided : 0,
  };
}

/**
 * Turn the ``byMatchup`` object ({ "vs P": {wins,losses,total,...} }) into
 * a sorted array. Keys are race letters ("vs P" / "vs Unknown") — no
 * identities — so they're safe to surface verbatim.
 *
 * @param {Record<string, {wins?: number, losses?: number, total?: number}> | null | undefined} byMatchup
 */
function shapeMatchups(byMatchup) {
  if (!byMatchup || typeof byMatchup !== "object") return [];
  /** @type {Array<{matchup: string, games: number, wins: number, losses: number, winRate: number}>} */
  const rows = [];
  for (const [matchup, v] of Object.entries(byMatchup)) {
    const wins = intOf(v && v.wins);
    const losses = intOf(v && v.losses);
    const games = intOf(v && v.total);
    if (games <= 0) continue;
    const decided = wins + losses;
    rows.push({
      matchup,
      games,
      wins,
      losses,
      winRate: decided > 0 ? wins / decided : 0,
    });
  }
  rows.sort((a, b) => b.games - a.games);
  return rows.slice(0, MATCHUP_LIMIT);
}

/**
 * Pick the user's signature builds from the per-build win-rate list.
 * These are the user's OWN ``myBuild`` labels (strategy names like
 * "PvT - Glaive Adept Timing"), never opponent data. Drops the synthetic
 * "Unknown" bucket, too-short-game buckets, and anything below the
 * minimum sample size, then keeps the most-played few.
 *
 * @param {Array<{name?: string, wins?: number, losses?: number, total?: number, winRate?: number}> | null | undefined} rows
 */
function shapeSignatureBuilds(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => {
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name || name === "Unknown") return false;
      if (/Game Too Short$/.test(name)) return false;
      return intOf(r.total) >= SIGNATURE_MIN_GAMES;
    })
    .sort((a, b) => intOf(b.total) - intOf(a.total))
    .slice(0, SIGNATURE_LIMIT)
    .map((r) => {
      const wins = intOf(r.wins);
      const losses = intOf(r.losses);
      const games = intOf(r.total);
      const decided = wins + losses;
      return {
        name: String(r.name).trim(),
        games,
        wins,
        losses,
        winRate: decided > 0 ? wins / decided : 0,
      };
    });
}

/**
 * Reduce the author aggregate's ``topBuild`` (full public projection) to
 * just the shareable link fields. Already-public community-build data —
 * safe to surface — but we narrow it so the build snapshot / owner id
 * never ride along on the profile payload.
 *
 * @param {{slug?: string, title?: string, matchup?: string, votes?: number} | null | undefined} topBuild
 */
function shapeFeaturedBuild(topBuild) {
  if (!topBuild || typeof topBuild.slug !== "string" || !topBuild.slug) {
    return null;
  }
  return {
    slug: topBuild.slug,
    title: typeof topBuild.title === "string" ? topBuild.title : topBuild.slug,
    matchup:
      typeof topBuild.matchup === "string" && topBuild.matchup
        ? topBuild.matchup
        : null,
    votes: intOf(topBuild.votes),
  };
}

/** @param {unknown} v */
function intOf(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

module.exports = {
  PublicProfileService,
  SIGNATURE_MIN_GAMES,
  SIGNATURE_LIMIT,
};
