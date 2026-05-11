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

function matchupLabel(myRace, oppRace) {
  const m = (myRace || "").charAt(0).toUpperCase();
  const o = (oppRace || "").charAt(0).toUpperCase();
  if (!m || !o) return undefined;
  return `${m}v${o}`;
}

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
   * }} [services]
   */
  constructor(db, services = {}) {
    this.db = db;
    this.opponents = services.opponents || null;
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
              },
            },
          )
          .catch(() => null)
      : null;

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
   * Build a pre-game ``LiveGamePayload``-shaped object from just an
   * opponent identity (name + race + optional Pulse character ID +
   * optional toon_handle). The cloud has the streamer's full game
   * history; we use it to fill in the SAME contextual fields the
   * post-game card carries (head-to-head, RIVAL/FAMILIAR, last-games
   * list, best answer, cheese probability, predicted strategies, top
   * builds, meta) so the scouting widget renders the rich pre-game
   * dossier instead of just "Looking up opponent…".
   *
   * Result-specific fields (``result``, ``durationSec``,
   * ``mmrDelta``, ``map``) are NOT populated — those only land
   * post-game when the replay parses. The ``map`` field can be set
   * by the agent later if Blizzard's local API ever exposes it pre-
   * game; today the loading screen has it but the SC2 client doesn't
   * surface it.
   *
   * **Three-tier opponent-row lookup.** The opponents collection
   * stores TWO identity fields (see ``util/opponentIdentity.js``):
   * ``pulseId`` is the raw sc2reader toon_handle, ``pulseCharacterId``
   * is the canonical SC2Pulse numeric id. Display name lives under
   * ``displayNameSample`` (HMAC under ``displayNameHash``). We try
   * each identifier in order of stability:
   *
   *   * Tier A — by ``pulseCharacterId``: most stable, survives the
   *     rare Battle.net rebind that rotates the toon_handle while
   *     keeping the Pulse character identity stable.
   *   * Tier B — by ``pulseId`` (toon_handle): covers opponents
   *     whose row pre-dates SC2Pulse resolution, or whose
   *     ``pulseCharacterId`` hasn't been backfilled yet.
   *   * Tier C — by ``displayNameSample`` with race disambiguation:
   *     last-resort match when neither identifier is supplied (legacy
   *     pre-Pulse agents) or known. Race ties pick the row with the
   *     largest ``gameCount``.
   *
   * @param {string} userId
   * @param {string} opponentName
   * @param {string} [opponentRace]
   * @param {string|number|null} [opponentPulseCharacterId] numeric
   *   SC2Pulse character id from the live envelope's
   *   ``opponent.profile.pulse_character_id``. May arrive as a number
   *   (JSON wire) or string — stringified before the Mongo query
   *   because the opponents collection persists it as a string.
   * @param {string} [myRace]
   * @param {string|null} [opponentToonHandle] raw sc2reader
   *   ``toon_handle`` (``region-S2-realm-bnid``) from the live
   *   envelope's ``opponent.toonHandle``. Used for Tier B when no
   *   Pulse character id is available, OR as a strict equality fall-
   *   back when Tier A misses (e.g. pulseCharacterId hasn't been
   *   backfilled on this opponent's row yet).
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
   * a sibling module. See that module for cache-key precedence rules
   * and the partial-then-enriched fan-out contract with the broker.
   *
   * @param {string} userId
   * @param {object} envelope
   * @returns {Promise<object>}
   */
  async enrichEnvelope(userId, envelope) {
    return enrichEnvelopeImpl(
      this,
      this._enrichmentCache,
      this._enrichmentTtlMs,
      this._enrichmentMax,
      userId,
      envelope,
    );
  }

  /** Test helper: drop the per-user enrichment cache. */
  clearEnrichmentCache() {
    this._enrichmentCache.clear();
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
   * @param {string} [widget]
   * @returns {object}
   */
  static buildSamplePayload(widget) {
    return buildSamplePayload(widget);
  }

  /* ============================================================
   * Private aggregation helpers — thin delegators to
   * ``overlayLiveAggregations.js``. The class methods stay as the
   * public surface so the rest of the service code (``buildFromGame``
   * / ``buildFromOpponentName``) doesn't need to know about the
   * extraction.
   * ============================================================ */

  _computeStreak(userId) {
    return aggregations.computeStreak(this.db.games, userId);
  }

  _previousGameMmr(userId, excludeGameId, beforeDate) {
    return aggregations.previousGameMmr(
      this.db.games,
      userId,
      excludeGameId,
      beforeDate,
    );
  }

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

  _topBuildsForMatchup(userId, myRace, oppRace) {
    return aggregations.topBuildsForMatchup(this.db.games, userId, myRace, oppRace);
  }

  _bestAnswerVsStrategy(userId, myRace, oppRace, strategy) {
    return aggregations.bestAnswerVsStrategy(
      this.db.games,
      userId,
      myRace,
      oppRace,
      strategy,
    );
  }

  _metaForMatchup(userId, myRace, oppRace) {
    return aggregations.metaForMatchup(this.db.games, userId, myRace, oppRace);
  }
}

module.exports = {
  OverlayLiveService,
  leagueFromMmr,
  cheeseProbability,
  matchupLabel,
  bucketResult,
};
