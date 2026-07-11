"use strict";

const { buildSamplePayload } = require("./overlayLiveSamples");
const {
  enrichEnvelope: enrichEnvelopeImpl,
  invalidateEnrichmentForOpponent: invalidateEnrichmentForOpponentImpl,
} = require("./overlayLiveEnrichment");
const aggregations = require("./overlayLiveAggregations");

const { bucketResult } = aggregations;

/**
 * OverlayLiveService — derives the cloud's authoritative
 * ``LiveGamePayload`` for the OBS overlay.
 *
 * The legacy SPA's overlay required a local agent to push pre/post-game
 * data into the overlay socket room. In the cloud architecture every
 * widget except the session card historically sat blank because the
 * agent's ``push_overlay_live`` helper was wired but never called.
 *
 * This service closes that loop server-side: each time the agent
 * uploads a fresh game, we synthesise the same payload the legacy
 * pipeline would have pushed, then broadcast it to the user's overlay
 * sockets. Widgets render real data without the agent ever opening a
 * socket connection of its own.
 *
 * It also produces synthetic sample payloads for the Settings →
 * Overlay "Test" button, so streamers can validate their OBS layout
 * without waiting for a real ladder match.
 *
 * Field shape mirrors ``apps/web/components/overlay/types.ts`` exactly
 * — every key the renderer reads must come from here in the same case.
 */

/**
 * Synthetic Test-button payload shape (``buildSamplePayload``). The
 * payload mirrors ``LiveGamePayload`` and is emitted wholesale to the
 * overlay sockets; only two members are manipulated server-side by
 * the /v1/overlay-events/test route, so they're pinned here and the
 * rest of the widget fields ride under the index signature:
 *   * ``isTest`` — stamped ``true`` before broadcast so widgets cap
 *     their visibility timers;
 *   * ``session`` — spread onto the dedicated ``overlay:session``
 *     event for the session card (shape mirrors
 *     ``GamesService.todaySession``).
 *
 * @typedef {Record<string, any> & {
 *   isTest?: boolean,
 *   session?: {
 *     wins?: number,
 *     losses?: number,
 *     games?: number,
 *     mmrStart?: number,
 *     mmrCurrent?: number,
 *     region?: string,
 *     sessionStartedAt?: string,
 *     streak?: { kind: string, count: number },
 *   },
 * }} SampleOverlayPayload
 */

/**
 * Strategy keywords that the cheese widget should highlight. Lowercase
 * match against ``opponent.strategy`` (substring) so variants like
 * "6 Pool" / "Pool first" / "Proxy 2 Gate" all light up. The threshold
 * the widget renders against (``cheeseProbability >= 0.4``) means we
 * pick a probability that comfortably crosses it — 0.7 — for any hit.
 * Non-matches get a baseline 0.1 so the widget hides itself.
 */
const CHEESE_KEYWORDS = [
  "cheese",
  "proxy",
  "cannon rush",
  "pool first",
  "6 pool",
  "8 pool",
  "all-in",
  "allin",
  "all in",
  "bunker rush",
  "worker rush",
];

/**
 * Map a numeric MMR to a Blizzard ladder league name + tier guess.
 * Boundaries follow Blizzard's published season cutoffs (approximate —
 * tiers within a league shift by a few hundred MMR each season). When
 * an upstream rank-resolver feeds us a real league later we can swap
 * this for the canonical mapping; for now this keeps the rank widget
 * rendering something plausible the second a game lands.
 *
 * @param {unknown} mmr
 * @returns {{league: string, tier: number} | null}
 */
function leagueFromMmr(mmr) {
  if (typeof mmr !== "number" || !Number.isFinite(mmr)) return null;
  if (mmr >= 6500) return { league: "Grandmaster", tier: 1 };
  if (mmr >= 5400) return { league: "Master", tier: 1 };
  if (mmr >= 5000) return { league: "Master", tier: 2 };
  if (mmr >= 4600) return { league: "Master", tier: 3 };
  if (mmr >= 4200) return { league: "Diamond", tier: 1 };
  if (mmr >= 3900) return { league: "Diamond", tier: 2 };
  if (mmr >= 3600) return { league: "Diamond", tier: 3 };
  if (mmr >= 3300) return { league: "Platinum", tier: 1 };
  if (mmr >= 3000) return { league: "Platinum", tier: 2 };
  if (mmr >= 2700) return { league: "Platinum", tier: 3 };
  if (mmr >= 2400) return { league: "Gold", tier: 1 };
  if (mmr >= 2100) return { league: "Gold", tier: 2 };
  if (mmr >= 1800) return { league: "Gold", tier: 3 };
  if (mmr >= 1500) return { league: "Silver", tier: 1 };
  if (mmr >= 1200) return { league: "Silver", tier: 2 };
  if (mmr >= 900) return { league: "Silver", tier: 3 };
  if (mmr >= 600) return { league: "Bronze", tier: 1 };
  return { league: "Bronze", tier: 3 };
}

/**
 * Compose a "PvZ"-style matchup label from two race names/letters.
 * Undefined when either side is missing so the widget can hide.
 *
 * @param {string} [myRace]
 * @param {string} [oppRace]
 * @returns {string | undefined}
 */
function matchupLabel(myRace, oppRace) {
  const m = (myRace || "").charAt(0).toUpperCase();
  const o = (oppRace || "").charAt(0).toUpperCase();
  if (!m || !o) return undefined;
  return `${m}v${o}`;
}

/**
 * Probability the cheese widget renders for a stored opponent
 * strategy. Keyword hits land at 0.7 (above the widget's 0.4
 * threshold); everything else at the hide-me baseline 0.1.
 *
 * @param {unknown} strategy
 * @returns {number}
 */
function cheeseProbability(strategy) {
  if (!strategy) return 0.1;
  const s = String(strategy).toLowerCase();
  for (const k of CHEESE_KEYWORDS) {
    if (s.includes(k)) return 0.7;
  }
  return 0.1;
}

class OverlayLiveService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   opponents: import('mongodb').Collection,
   * }} db
   * @param {{
   *   opponents?: any,
   *   gameDetails?: import('./gameDetails').GameDetailsService | null,
   * }} [services]
   */
  constructor(db, services = {}) {
    this.db = db;
    this.opponents = services.opponents || null;
    /**
     * Detail-store reader used by ``opponentPhases`` to hydrate
     * ``macroBreakdown`` from the post-v0.4.3 detail blob. Optional —
     * when absent the phase forecast is skipped and the rest of
     * ``streamerHistory`` still lands.
     * @type {import('./gameDetails').GameDetailsService | null}
     */
    this.gameDetails = services.gameDetails || null;
    /**
     * Per-(userId, oppName, oppRace) cache for live-envelope
     * enrichment. The agent fires envelopes at 1 Hz during a match;
     * caching lets the broker emit the rich card on every tick
     * without re-running the Mongo aggregation pipeline.
     *
     * 5-minute TTL — long enough to survive a typical match, short
     * enough that a streamer who steps away and comes back doesn't
     * see stale H2H if they played the same opponent twice in a row.
     * @type {Map<string, {payload: object|null, ts: number}>}
     */
    this._enrichmentCache = new Map();
    this._enrichmentTtlMs = 5 * 60 * 1000;
    this._enrichmentMax = 256;
    /**
     * Per-user "most recently enriched gameKey". The voice-readout
     * bug we hit at 2026-05-11 happened when a new match's loading-
     * screen envelope arrived BEFORE the previous match's post-game
     * ingest had a chance to call ``invalidateEnrichmentForOpponent``.
     * The cache returned stale H2H from before the prior match was
     * counted, the voice spoke it, and only later envelopes (after
     * Pulse responded and the post-game invalidate ran) saw fresh
     * data — which the visual card then rendered.
     *
     * Fix: bypass the cache on the FIRST envelope of any new
     * ``gameKey`` (always hit Mongo). Subsequent ticks of the same
     * match still use the cache, so the 1-Hz cadence stays cheap.
     * @type {Map<string, string>}
     */
    this._lastEnrichedGameKey = new Map();
  }

  /**
   * Build a complete ``LiveGamePayload`` from one freshly-ingested
   * game, hydrating cross-cutting fields (H2H, MMR delta, streak, top
   * builds) from the user's broader history.
   *
   * Returns ``null`` when the game is too thin to meaningfully populate
   * the overlay — e.g. a stub with no opponent and no result. The
   * caller should skip the broadcast in that case.
   *
   * @param {string} userId
   * @param {Record<string, any>} game
   * @returns {Promise<object | null>}
   */
  async buildFromGame(userId, game) {
    if (!game || !userId) return null;
    const opp = game.opponent || null;
    const myRace = game.myRace || undefined;
    const oppRace = opp?.race || undefined;
    /** @type {Record<string, any>} */
    const payload = {};
    if (myRace) payload.myRace = myRace;
    if (oppRace) payload.oppRace = oppRace;
    if (opp?.displayName) payload.oppName = opp.displayName;
    if (game.map) payload.map = game.map;
    const matchup = matchupLabel(myRace, oppRace);
    if (matchup) payload.matchup = matchup;
    const bucket = bucketResult(game.result);
    if (bucket) payload.result = bucket;
    if (Number.isFinite(Number(game.durationSec))) {
      payload.durationSec = Number(game.durationSec);
    }
    if (Number.isFinite(Number(opp?.mmr))) payload.oppMmr = Number(opp.mmr);
    if (Number.isFinite(Number(game.myMmr))) payload.myMmr = Number(game.myMmr);

    // Head-to-head from the opponents row, when the agent supplied a
    // pulseId. The opponents row is the cheap pre-aggregated counter;
    // a falsy lookup just means we skip the H2H/Rival/Rematch widgets
    // for this payload, never blocks the broadcast.
    const oppRow = opp?.pulseId
      ? await this.db.opponents
          .findOne(
            { userId, pulseId: opp.pulseId },
            {
              projection: {
                _id: 0,
                gameCount: 1,
                wins: 1,
                losses: 1,
                lastSeen: 1,
                openings: 1,
                revealedName: 1,
              },
            },
          )
          .catch(() => null)
      : null;

    // SC2Pulse "revealed" name behind a barcode (when the community
    // linked the anonymised account to a known pro/main). Persisted on
    // the opponents row by the MMR / reveal re-check passes; surfaced so
    // the overlay can label the bars with the real identity.
    if (oppRow?.revealedName) payload.oppRevealedName = oppRow.revealedName;

    if (oppRow) {
      const wins = Number(oppRow.wins) || 0;
      const losses = Number(oppRow.losses) || 0;
      payload.headToHead = { wins, losses };
      // Rival = repeat opponent (≥3 prior encounters). The widget
      // hides itself for casual one-off opponents — only flag the row
      // once the streamer has crossed paths enough to justify the
      // panel real estate.
      const games = Number(oppRow.gameCount) || wins + losses;
      if (games >= 3) {
        payload.rival = {
          name: opp?.displayName || undefined,
          headToHead: { wins, losses },
        };
      }
      // Rematch = same opponent within the last 24h, more than once.
      const lastSeen = oppRow.lastSeen
        ? new Date(oppRow.lastSeen).getTime()
        : null;
      if (
        lastSeen !== null
        && games >= 2
        && Date.now() - lastSeen <= 24 * 60 * 60 * 1000
      ) {
        payload.rematch = { isRematch: true, lastResult: bucket || undefined };
      }
      // Fav opening — most-frequent opening row stored in ``openings``.
      const openings = oppRow.openings && typeof oppRow.openings === "object"
        ? oppRow.openings
        : null;
      if (openings) {
        const entries = Object.entries(openings).filter(
          ([, v]) => Number.isFinite(Number(v)) && Number(v) > 0,
        );
        if (entries.length > 0) {
          entries.sort((a, b) => Number(b[1]) - Number(a[1]));
          const [name, count] = entries[0];
          const total = entries.reduce((acc, [, v]) => acc + Number(v), 0);
          payload.favOpening = {
            name,
            share: total > 0 ? Number(count) / total : 0,
            samples: Number(count),
          };
        }
      }
    }

    // Cheese alert — lit by the opponent's stored strategy.
    const cp = cheeseProbability(opp?.strategy);
    if (cp >= 0.4) payload.cheeseProbability = cp;

    // Predicted strategies — naive in-row weighting from the openings
    // map. The dashboard's recency-weighted predictor is richer but it
    // requires hydrating the full per-opponent game list; the overlay
    // panel only renders the top 3, so the openings counts are a
    // proportional-enough signal.
    if (oppRow?.openings) {
      const total = Object.values(oppRow.openings).reduce(
        (acc, v) => acc + Number(v || 0),
        0,
      );
      if (total > 0) {
        const preds = Object.entries(oppRow.openings)
          .map(([name, v]) => ({
            name,
            weight: Number(v) / total,
          }))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 3);
        if (preds.length > 0) payload.predictedStrategies = preds;
        // Scouting tells: project the same predictions but with a
        // confidence column so the scouting widget can render "look
        // for X by Y minutes".
        payload.scouting = preds.map((p) => ({
          label: p.name,
          confidence: p.weight,
        }));
      }
    }

    // Streak — walk the most-recent N games and count the current run.
    const streak = await this._computeStreak(userId);
    if (streak) payload.streak = streak;

    // MMR delta — compare against the previous game's myMmr if both
    // are populated. Otherwise leave undefined so the widget hides.
    if (Number.isFinite(Number(game.myMmr))) {
      const prev = await this._previousGameMmr(userId, game.gameId, game.date);
      if (prev !== null) {
        payload.mmrDelta = Number(game.myMmr) - prev;
      }
    }

    // Rank — derived from the just-played game's myMmr.
    if (Number.isFinite(Number(game.myMmr))) {
      const lg = leagueFromMmr(Number(game.myMmr));
      payload.rank = {
        ...(lg || {}),
        mmr: Number(game.myMmr),
      };
    }

    // Top builds the streamer has used in this matchup.
    if (matchup) {
      const top = await this._topBuildsForMatchup(userId, myRace, oppRace);
      if (top.length > 0) payload.topBuilds = top;
    }

    // Last N games vs this opponent in this matchup. Drives the
    // scouting card's "LAST GAMES" rows. We exclude the just-uploaded
    // game from the list so the widget shows *prior* meetings — the
    // current game's result is surfaced separately by match-result/
    // post-game widgets.
    if (opp) {
      const recent = await this._recentGamesForOpponent(
        userId,
        opp,
        myRace,
        oppRace,
        game.gameId,
      );
      if (recent.length > 0) payload.recentGames = recent;
    }

    // Best answer — for the opponent's most-likely opening, the
    // streamer's myBuild with the highest winRate (≥3 games for noise).
    const favOpeningStrategy = payload.favOpening?.name;
    if (favOpeningStrategy && myRace && oppRace) {
      const ans = await this._bestAnswerVsStrategy(
        userId,
        myRace,
        oppRace,
        favOpeningStrategy,
      );
      if (ans) payload.bestAnswer = ans;
    }

    // Meta — top opening shares for this matchup across the user's
    // own history. (A true ladder-wide meta would need a cross-user
    // aggregation; that's a separate project — for now we surface the
    // streamer's own match sample as "what's been working in this MU".)
    if (matchup) {
      const meta = await this._metaForMatchup(userId, myRace, oppRace);
      if (meta) payload.meta = { matchup, topBuilds: meta };
    }

    return payload;
  }

  /**
   * Build a pre-game ``LiveGamePayload``-shaped object from an
   * opponent identity. Mirrors the post-game card's contextual fields
   * (H2H, RIVAL/FAMILIAR, last-games list, best answer, predicted
   * strategies, top builds, meta, opponent phases, last5GamesScouting)
   * — result-specific fields (result/durationSec/mmrDelta/map) are
   * NOT populated; those only land post-game.
   *
   * Three-tier opponent-row lookup:
   *   * Tier A — ``pulseCharacterId`` (most stable; survives toon_handle rotation).
   *   * Tier B — ``pulseId`` (toon_handle) — covers pre-SC2Pulse rows.
   *   * Tier C — ``displayNameSample`` + race disambiguation (legacy fallback).
   *
   * @param {string} userId
   * @param {string} opponentName
   * @param {string} [opponentRace]
   * @param {string|number|null} [opponentPulseCharacterId]
   * @param {string} [myRace]
   * @param {string|null} [opponentToonHandle]
   * @returns {Promise<object|null>}
   */
  async buildFromOpponentName(
    userId,
    opponentName,
    opponentRace,
    opponentPulseCharacterId,
    myRace,
    opponentToonHandle,
  ) {
    if (!userId || !opponentName) return null;
    /** @type {Record<string, any>} */
    const payload = { oppName: opponentName };
    if (opponentRace) payload.oppRace = opponentRace;
    if (myRace) payload.myRace = myRace;
    const matchup = matchupLabel(myRace, opponentRace);
    if (matchup) payload.matchup = matchup;

    // Three-tier opponent-row lookup — see JSDoc above for the order
    // and rationale. The projection covers the union of every field
    // the three tiers (and the downstream payload derivation) actually
    // read: identity (pulseId / pulseCharacterId), display
    // (displayNameSample), counters (gameCount, wins, losses), recency
    // (lastSeen), strategy mix (openings), race (used to break
    // display-name collisions in Tier C), and the last-observed
    // ``mmr`` so the scouting widget can show a record even when
    // SC2Pulse's live profile lookup hasn't returned a current MMR
    // (e.g. the opponent hasn't played enough ranked games this season
    // for Pulse to expose one). The post-game card already surfaces
    // this from the freshly-uploaded game; here we backstop the pre-
    // game card so it doesn't fall to "MMR unavailable" against a
    // repeat opponent whose stored MMR we already know.
    const projection = {
      _id: 0,
      pulseId: 1,
      pulseCharacterId: 1,
      displayNameSample: 1,
      race: 1,
      mmr: 1,
      gameCount: 1,
      wins: 1,
      losses: 1,
      lastSeen: 1,
      openings: 1,
      revealedName: 1,
    };
    /** @type {Record<string, any>|null} */
    let oppRow = null;
    // Tier A — by SC2Pulse character id (stringified; the field is
    // persisted as a string per OpponentsService.recordGame, but the
    // envelope value arrives as a number from the JSON wire).
    const pcidString =
      opponentPulseCharacterId !== undefined
      && opponentPulseCharacterId !== null
      && String(opponentPulseCharacterId).length > 0
        ? String(opponentPulseCharacterId)
        : null;
    if (pcidString) {
      oppRow = await this.db.opponents
        .findOne(
          { userId, pulseCharacterId: pcidString },
          { projection },
        )
        .catch(() => null);
      if (oppRow) oppRow.matchedBy = "pulse_character_id";
    }
    // Tier B — by toon_handle (legacy ``pulseId`` field). Covers
    // opponents whose row pre-dates SC2Pulse resolution OR whose
    // ``pulseCharacterId`` hasn't been backfilled yet by the resolver
    // cron.
    if (!oppRow && typeof opponentToonHandle === "string" && opponentToonHandle.length > 0) {
      oppRow = await this.db.opponents
        .findOne(
          { userId, pulseId: opponentToonHandle },
          { projection },
        )
        .catch(() => null);
      if (oppRow) oppRow.matchedBy = "toon_handle";
    }
    // Tier C — by displayNameSample + race disambiguation. Last-resort
    // for legacy pre-Pulse agents and the unresolved-identity case;
    // race breaks the common display-name collision (multiple
    // barcodes / players sharing a name across races).
    if (!oppRow) {
      const candidates = await this.db.opponents
        .find({ userId, displayNameSample: opponentName }, { projection })
        .toArray()
        .catch(() => []);
      if (candidates.length > 0) {
        const oppInitial = opponentRace
          ? String(opponentRace).charAt(0).toUpperCase()
          : null;
        const raceMatches = oppInitial
          ? candidates.filter((c) => {
              const r = typeof c.race === "string" ? c.race.charAt(0).toUpperCase() : "";
              return r === oppInitial;
            })
          : [];
        const pool = raceMatches.length > 0 ? raceMatches : candidates;
        pool.sort(
          (a, b) => (Number(b.gameCount) || 0) - (Number(a.gameCount) || 0),
        );
        oppRow = pool[0];
        if (oppRow) oppRow.matchedBy = "display_name";
      }
    }

    if (oppRow) {
      const wins = Number(oppRow.wins) || 0;
      const losses = Number(oppRow.losses) || 0;
      payload.headToHead = { wins, losses };
      // SC2Pulse "revealed" identity behind a barcode, when we've
      // captured it for this opponent. Lets the pre-game scouting card
      // label the bars with the real name.
      if (oppRow.revealedName) payload.oppRevealedName = oppRow.revealedName;
      // Last-observed MMR from the opponents row. The post-game card
      // surfaces ``oppMmr`` from the just-uploaded game; pre-game we
      // fall back to the most recent value the agent stamped on this
      // opponent during a prior encounter. Renderer prefers this over
      // ``profile.mmr`` when both are present because the stored row
      // is the value Battle.net itself reported in their last match,
      // whereas SC2Pulse's profile MMR can lag (or be null entirely
      // when the player hasn't logged enough season games for Pulse
      // to publish one).
      if (Number.isFinite(Number(oppRow.mmr))) {
        payload.oppMmr = Number(oppRow.mmr);
      }
      const games = Number(oppRow.gameCount) || wins + losses;
      // Same RIVAL / FAMILIAR threshold as buildFromGame (3+ prior
      // encounters) so the pre-game card flags repeat opponents the
      // same way the post-game card does.
      if (games >= 3) {
        payload.rival = {
          name: oppRow.displayNameSample || opponentName,
          headToHead: { wins, losses },
        };
      }
      const lastSeen = oppRow.lastSeen
        ? new Date(oppRow.lastSeen).getTime()
        : null;
      // Pre-game rematch flag: same opponent within 24 h, prior
      // encounters >= 2. ``lastResult`` is unknown pre-game (we
      // haven't played the current match yet) so the widget renders
      // a generic "rematch" without the win/loss shading.
      if (
        lastSeen !== null
        && games >= 2
        && Date.now() - lastSeen <= 24 * 60 * 60 * 1000
      ) {
        payload.rematch = { isRematch: true };
      }
      const openings = oppRow.openings && typeof oppRow.openings === "object"
        ? oppRow.openings
        : null;
      if (openings) {
        const entries = Object.entries(openings).filter(
          ([, v]) => Number.isFinite(Number(v)) && Number(v) > 0,
        );
        if (entries.length > 0) {
          entries.sort((a, b) => Number(b[1]) - Number(a[1]));
          const [name, count] = entries[0];
          const total = entries.reduce((acc, [, v]) => acc + Number(v), 0);
          payload.favOpening = {
            name,
            share: total > 0 ? Number(count) / total : 0,
            samples: Number(count),
          };
        }
        const total = Object.values(openings).reduce(
          (acc, v) => acc + Number(v || 0),
          0,
        );
        if (total > 0) {
          const preds = Object.entries(openings)
            .map(([name, v]) => ({ name, weight: Number(v) / total }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 3);
          if (preds.length > 0) payload.predictedStrategies = preds;
          payload.scouting = preds.map((p) => ({
            label: p.name,
            confidence: p.weight,
          }));
        }
      }
      // Cheese probability — derived from the opponent's most-played
      // opening if it matches the cheese keyword list. Pre-game we
      // don't know what THIS match's strategy will be, so the
      // probability reflects "they tend to bring this on the ladder".
      if (payload.favOpening?.name) {
        const cp = cheeseProbability(payload.favOpening.name);
        if (cp >= 0.4) payload.cheeseProbability = cp;
      }
    } else {
      // No opponents row matched any of the three identity tiers —
      // the cloud has never seen this player before. Stamp an explicit
      // zero-zero ``headToHead`` so the renderer (and the voice
      // readout) can distinguish "confirmed first meeting" from
      // "enrichment hasn't landed yet" (in which case ``headToHead``
      // is simply absent). The voice readout uses this signal to say
      // "First meeting." rather than staying silent on the H2H slot.
      payload.headToHead = { wins: 0, losses: 0 };
    }

    // Streak — global, not opponent-specific.
    const streak = await this._computeStreak(userId);
    if (streak) payload.streak = streak;

    // Last N games against this opponent in this matchup. Same shape
    // as the post-game card's ``recentGames`` list — the widget can
    // render the row builder unchanged. We prefer the matched
    // ``oppRow``'s identity fields over the envelope-supplied ones
    // because (a) the row is authoritative (the agent writes it
    // game-by-game) and (b) Tier C may have matched a row whose
    // identity differs from what arrived on the envelope — in which
    // case the row's identifiers are the ones the user's games are
    // stamped with.
    const opp = {
      pulseId: oppRow?.pulseId || opponentToonHandle || undefined,
      pulseCharacterId: oppRow?.pulseCharacterId || pcidString || undefined,
      displayName: oppRow?.displayNameSample || opponentName,
      race: opponentRace,
    };
    const recent = await this._recentGamesForOpponent(
      userId,
      opp,
      myRace,
      opponentRace,
      // No exclude — every prior match counts pre-game.
      undefined,
    );
    if (recent.length > 0) payload.recentGames = recent;

    // Phase forecast — drives the scouting card's "Usually reaches
    // Mid/Late" strip. Best-effort: a Mongo or detail-store blip must
    // NOT block the rest of the pre-game card; absent ``opponentPhases``
    // renders nothing in that slot, which is the desired fallback.
    try {
      const phases = await this._opponentPhaseProfile(
        userId, opp, myRace, opponentRace,
      );
      if (phases) payload.opponentPhases = phases;
    } catch { /* swallow */ }

    // Per-game scouting envelopes for the overlay's "Last 5 games"
    // block. Best-effort guard as above.
    try {
      const scouting = await aggregations.last5GamesScouting(
        this.db.games, this.gameDetails, userId, opp, myRace, opponentRace,
      );
      if (scouting.length > 0) payload.last5GamesScouting = scouting;
    } catch (err) {
      const e = /** @type {{ message?: unknown }} */ (err);
      console.warn(
        "overlayLive: last5GamesScouting failed for userId=%s: %s",
        userId, (e && e.message) || e,
      );
    }

    // Best answer vs the opponent's most-likely opening.
    const favOpeningStrategy = payload.favOpening?.name;
    if (favOpeningStrategy && myRace && opponentRace) {
      const ans = await this._bestAnswerVsStrategy(
        userId,
        myRace,
        opponentRace,
        favOpeningStrategy,
      );
      if (ans) payload.bestAnswer = ans;
    }

    // Top builds the streamer has used in this matchup.
    if (matchup) {
      const top = await this._topBuildsForMatchup(userId, myRace, opponentRace);
      if (top.length > 0) payload.topBuilds = top;
    }

    // Matchup meta (top opening shares).
    if (matchup) {
      const meta = await this._metaForMatchup(userId, myRace, opponentRace);
      if (meta && meta.length > 0) payload.meta = { matchup, topBuilds: meta };
    }

    return payload;
  }

  /**
   * Enrich an inbound ``LiveGameState`` envelope with
   * ``streamerHistory``. Thin delegator to ``overlayLiveEnrichment.js``
   * so the class API stays unchanged while the heavy lifting lives in
   * a sibling module.
   *
   * Detects the FIRST envelope of any new ``gameKey`` and forces a
   * cache-bypass for that single call, so a streamer who queues
   * immediately after a prior game sees their freshly-updated H2H
   * even when the prior match's invalidate hasn't landed yet. The
   * subsequent 1 Hz ticks of the same match still use the cache.
   *
   * @param {string} userId
   * @param {Record<string, any>} envelope inbound ``LiveGameState``
   *   envelope (see ``overlayLiveEnrichment.LiveEnvelopeLike`` for the
   *   fields the enrichment path reads; everything else rides through).
   * @returns {Promise<object>}
   */
  async enrichEnvelope(userId, envelope) {
    const gameKey = envelope && typeof envelope.gameKey === "string"
      ? envelope.gameKey
      : null;
    const lastKey = userId ? this._lastEnrichedGameKey.get(userId) : null;
    const isFirstForGameKey = gameKey !== null && gameKey !== lastKey;
    if (userId && gameKey !== null) {
      this._lastEnrichedGameKey.set(userId, gameKey);
    }
    return enrichEnvelopeImpl(
      this,
      this._enrichmentCache,
      this._enrichmentTtlMs,
      this._enrichmentMax,
      userId,
      envelope,
      isFirstForGameKey,
    );
  }

  /** Test helper: drop the per-user enrichment cache. */
  clearEnrichmentCache() {
    this._enrichmentCache.clear();
    this._lastEnrichedGameKey.clear();
  }

  /**
   * Drop cached enrichment for one (userId, opponent) pair after a
   * fresh game upload so the next pre-game card includes the new
   * encounter. Thin delegator — implementation lives in
   * ``overlayLiveEnrichment.js``.
   *
   * @param {string} userId
   * @param {string} opponentName
   * @param {string|number|null} [pulseCharacterId]
   */
  invalidateEnrichmentForOpponent(userId, opponentName, pulseCharacterId) {
    invalidateEnrichmentForOpponentImpl(
      this._enrichmentCache,
      userId,
      opponentName,
      pulseCharacterId,
    );
  }

  /**
   * Synthetic full / per-widget payload for the Settings → Overlay
   * Test button. Implementation lives in ``overlayLiveSamples`` to
   * keep this file focused on production derivation logic; the static
   * passthrough preserves the existing call site shape used by the
   * /v1/overlay-events/test route + unit tests.
   *
   * The declared return shape pins the two members the test route
   * manipulates before broadcasting: it stamps ``isTest`` onto the
   * payload, and re-emits the ``session`` block (spread + test flag)
   * on the dedicated ``overlay:session`` socket event. Every other
   * widget field rides through untouched under the index signature.
   *
   * @param {string} [widget]
   * @returns {SampleOverlayPayload}
   */
  static buildSamplePayload(widget) {
    return /** @type {SampleOverlayPayload} */ (buildSamplePayload(widget));
  }

  /* ============================================================
   * Private aggregation helpers — thin delegators to
   * ``overlayLiveAggregations.js``. The class methods stay as the
   * public surface so the rest of the service code (``buildFromGame``
   * / ``buildFromOpponentName``) doesn't need to know about the
   * extraction.
   * ============================================================ */

  /**
   * @param {string} userId
   * @returns {Promise<{kind: 'win'|'loss', count: number} | null>}
   */
  _computeStreak(userId) {
    return aggregations.computeStreak(this.db.games, userId);
  }

  /**
   * @param {string} userId
   * @param {string} [excludeGameId]
   * @param {Date|string} [beforeDate]
   * @returns {Promise<number|null>}
   */
  _previousGameMmr(userId, excludeGameId, beforeDate) {
    return aggregations.previousGameMmr(
      this.db.games,
      userId,
      excludeGameId,
      beforeDate,
    );
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} opp
   * @param {string} [myRace]
   * @param {string} [oppRace]
   * @param {string} [excludeGameId]
   */
  _recentGamesForOpponent(userId, opp, myRace, oppRace, excludeGameId) {
    return aggregations.recentGamesForOpponent(
      this.db.games,
      userId,
      opp,
      myRace,
      oppRace,
      excludeGameId,
    );
  }

  /**
   * Race args may be undefined at the type level (both call sites sit
   * behind an ``if (matchup)`` guard, which only holds when both races
   * are non-empty strings — a correlation the checker can't see). The
   * cast forwards them to the aggregation impl, which additionally
   * no-ops on a falsy race at runtime.
   *
   * @param {string} userId
   * @param {string|undefined} myRace
   * @param {string|undefined} oppRace
   */
  _topBuildsForMatchup(userId, myRace, oppRace) {
    return aggregations.topBuildsForMatchup(
      this.db.games,
      userId,
      /** @type {string} */ (myRace),
      /** @type {string} */ (oppRace),
    );
  }

  /**
   * @param {string} userId
   * @param {string} myRace
   * @param {string} oppRace
   * @param {string} strategy
   */
  _bestAnswerVsStrategy(userId, myRace, oppRace, strategy) {
    return aggregations.bestAnswerVsStrategy(
      this.db.games,
      userId,
      myRace,
      oppRace,
      strategy,
    );
  }

  /**
   * Same guarded-``matchup`` cast rationale as ``_topBuildsForMatchup``.
   *
   * @param {string} userId
   * @param {string|undefined} myRace
   * @param {string|undefined} oppRace
   */
  _metaForMatchup(userId, myRace, oppRace) {
    return aggregations.metaForMatchup(
      this.db.games,
      userId,
      /** @type {string} */ (myRace),
      /** @type {string} */ (oppRace),
    );
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} opp
   * @param {string} [myRace]
   * @param {string} [oppRace]
   */
  _opponentPhaseProfile(userId, opp, myRace, oppRace) {
    return aggregations.opponentPhaseProfile(
      this.db.games, this.gameDetails, userId, opp, myRace, oppRace,
    );
  }
}

module.exports = {
  OverlayLiveService,
  leagueFromMmr,
  cheeseProbability,
  matchupLabel,
  bucketResult,
};
