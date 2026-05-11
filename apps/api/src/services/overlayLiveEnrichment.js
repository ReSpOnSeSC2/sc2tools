"use strict";

const { regionFromToonHandle } = require("../util/regionFromToonHandle");

/**
 * Cloud-side enrichment helpers for the overlay-live pipeline.
 *
 * Extracted from ``overlayLive.js`` to keep that file under the
 * project's 800-line ceiling. The ``OverlayLiveService`` class methods
 * remain the public API — they're thin delegators here.
 *
 * What lives in this module:
 *
 *   - ``pickStreamerRace`` — derive the streamer's race from the
 *     agent's envelope ``players[]`` list.
 *   - ``pickEnvelopeRegion`` — derive the Blizzard region label from
 *     the opponent's toon_handle or the Pulse profile, with the
 *     ``US → NA`` canonicalisation the rest of the cloud uses.
 *   - ``buildEnrichmentKey`` — compose the cache key. The two-scheme
 *     split (pulse vs name+region) lives here so the writer and the
 *     invalidator share one source of truth on the prefix shape.
 *   - ``enrichEnvelope`` — merge ``streamerHistory`` onto a live
 *     envelope before fan-out, with a 5-minute (userId, opp) cache
 *     so the 1 Hz envelope cadence doesn't re-hit Mongo.
 *   - ``invalidateEnrichmentForOpponent`` — flush every cache entry
 *     for one (userId, opp) pair so a rematch within the cache
 *     window sees the freshly-uploaded encounter.
 *
 * Everything is exported as a plain function taking explicit
 * dependencies (the cache map, the service's
 * ``buildFromOpponentName`` method), so the module stays free of
 * hidden state and is straightforward to unit-test.
 */

/**
 * Pull the streamer's own race out of the agent's envelope. The
 * envelope carries one entry per player on ``players[]``; the
 * streamer's row has ``type === "user"`` AND
 * ``name === envelope.user.name`` (the explicit "you" hint the
 * bridge writes from the player handle cache). Falls back to picking
 * the player whose name matches the user when both players are
 * marked ``user`` in 1v1.
 *
 * @param {object} envelope
 * @returns {string | null}
 */
function pickStreamerRace(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const players = Array.isArray(envelope.players) ? envelope.players : [];
  if (players.length === 0) return null;
  const userName = envelope.user && typeof envelope.user.name === "string"
    ? envelope.user.name.trim().toLowerCase()
    : "";
  for (const p of players) {
    if (!p || typeof p !== "object") continue;
    if (p.type !== "user") continue;
    const pName = typeof p.name === "string" ? p.name.trim().toLowerCase() : "";
    if (userName && pName === userName) {
      return typeof p.race === "string" ? p.race : null;
    }
  }
  // Fallback: first ``user`` player. In a 1v1 ladder game with no
  // user_name hint set this is at best a 50/50; the matchup-scoped
  // queries it powers will simply yield nothing if the guess is
  // wrong, which is acceptable.
  for (const p of players) {
    if (p && p.type === "user" && typeof p.race === "string") {
      return p.race;
    }
  }
  return null;
}

/**
 * Pick the canonical Blizzard-region label for an envelope's
 * opponent. Precedence: the agent's ``opponent.toonHandle`` leading
 * region byte (most reliable — Battle.net itself stamps that byte),
 * then ``profile.region`` from the Pulse lookup, then ``null``.
 *
 * Used as part of the enrichment cache key when no Pulse character id
 * is available, so two opponents with identical display names on
 * different servers don't collide and cross-pollinate scouting data.
 *
 * @param {Record<string, any>} opp
 * @param {Record<string, any>|null} profile
 * @returns {string|null}
 */
function pickEnvelopeRegion(opp, profile) {
  if (opp && typeof opp.toonHandle === "string") {
    const inferred = regionFromToonHandle(opp.toonHandle);
    if (inferred) return inferred;
  }
  if (profile && typeof profile.region === "string" && profile.region) {
    // SC2Pulse labels NA as ``US``; the rest of the cloud session-
    // widget pipeline canonicalises to ``NA``. Mirror that here so a
    // single opponent's region is consistent regardless of which
    // identity branch fired first (toonHandle inference vs. Pulse
    // profile) — without this an envelope that arrives toonHandle-
    // first would key under ``NA`` and a follow-up envelope that
    // arrives Pulse-first would key under ``US``, splitting the
    // cache and double-fetching the aggregation.
    const upper = profile.region.trim().toUpperCase();
    return upper === "US" ? "NA" : upper;
  }
  return null;
}

/**
 * Compose the enrichment cache key. The two-scheme split lives here
 * so the writer (``enrichEnvelope``) and the invalidator
 * (``invalidateEnrichmentForOpponent``) agree on the prefix shape:
 *
 *   * ``${userId}|pulse:<pulse_character_id>|<myRace>`` — preferred,
 *     globally unique per Battle.net character.
 *   * ``${userId}|name:<lcname>|region:<NA|EU|...|?>|<lcoppRace>|<myRace>``
 *     — fallback when no Pulse id is available; region prevents a
 *     cross-server display-name collision (NA "Maru" vs EU "Maru").
 *
 * The unknown-region sentinel ``?`` keeps the key length stable
 * across servers so the LRU eviction order stays sensible.
 *
 * @param {{
 *   userId: string,
 *   pulseCharacterId: number|null,
 *   name: string,
 *   race: string,
 *   region: string|null,
 *   myRace: string|null,
 * }} parts
 * @returns {string}
 */
function buildEnrichmentKey(parts) {
  if (parts.pulseCharacterId !== null) {
    return `${parts.userId}|pulse:${parts.pulseCharacterId}|${parts.myRace || ""}`;
  }
  const region = parts.region || "?";
  return `${parts.userId}|name:${parts.name.toLowerCase()}|region:${region}|${parts.race.toLowerCase()}|${parts.myRace || ""}`;
}

/**
 * Enrich an inbound ``LiveGameState`` envelope with
 * ``streamerHistory`` — the H2H, recent games, RIVAL/FAMILIAR tag
 * the post-game card carries. Called by the LiveGameBroker before
 * it fans the envelope out to overlay sockets and SSE.
 *
 * Cached for 5 minutes so the 1 Hz envelope cadence doesn't re-hit
 * Mongo for every tick of the same match. The first envelope of a
 * new opponent is a cache miss (~50 ms aggregation); every
 * subsequent tick is a cache hit (microseconds).
 *
 * Returns the original envelope when there's nothing to enrich (no
 * opponent name / unknown opponent / no history).
 *
 * @param {object} service the ``OverlayLiveService`` instance, used
 *   for its ``buildFromOpponentName`` method.
 * @param {Map<string, {payload: object|null, ts: number}>} cache
 *   The LRU cache map owned by the service.
 * @param {number} ttlMs
 * @param {number} maxSize
 * @param {string} userId
 * @param {object} envelope
 * @returns {Promise<object>}
 */
async function enrichEnvelope(service, cache, ttlMs, maxSize, userId, envelope) {
  if (!userId || !envelope || typeof envelope !== "object") return envelope;
  const opp = envelope.opponent;
  if (!opp || typeof opp !== "object") return envelope;
  const name = typeof opp.name === "string" ? opp.name.trim() : "";
  if (!name) return envelope;
  const race = typeof opp.race === "string" ? opp.race.trim() : "";
  const profile = opp.profile && typeof opp.profile === "object" ? opp.profile : null;
  // Guard against ``Number(null) === 0`` collapsing every
  // missing-id envelope into the same cache slot. Only treat the
  // Pulse id as present when the field was non-null AND the
  // numeric coercion produced a finite value.
  const rawPcid = profile ? profile.pulse_character_id : null;
  const pulseCharacterId =
    rawPcid !== null && rawPcid !== undefined
      && Number.isFinite(Number(rawPcid))
      ? Number(rawPcid)
      : null;
  // Pull the raw toon_handle off the envelope so ``buildFromOpponentName``
  // can use it as the Tier B fallback when no Pulse character id was
  // resolved (or the opponents row has the toon_handle but no
  // ``pulseCharacterId`` yet). The agent stamps ``opp.toonHandle`` in
  // ``replay_pipeline._build_opponent``.
  const toonHandle =
    opp && typeof opp.toonHandle === "string" && opp.toonHandle.length > 0
      ? opp.toonHandle
      : null;
  // The agent's envelope carries the streamer's display name on
  // ``user.name`` and the player race on ``players[].race`` for the
  // ``user`` player. The streamer's race is what ``buildFromOppName``
  // needs for matchup-scoped queries.
  const myRace = pickStreamerRace(envelope);
  const region = pickEnvelopeRegion(opp, profile);

  const key = buildEnrichmentKey({
    userId,
    pulseCharacterId,
    name,
    race,
    region,
    myRace,
  });
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) {
    // LRU touch.
    cache.delete(key);
    cache.set(key, hit);
    if (!hit.payload) return envelope;
    return { ...envelope, streamerHistory: hit.payload };
  }

  let history = null;
  try {
    history = await service.buildFromOpponentName(
      userId,
      name,
      race || undefined,
      pulseCharacterId,
      myRace || undefined,
      toonHandle,
    );
  } catch {
    // Best-effort enrichment — never block the broker on a Mongo blip.
    history = null;
  }
  // Cache even null results so a Pulse-miss / unknown-opponent case
  // doesn't repeatedly hit the aggregation.
  cache.set(key, { payload: history || null, ts: now });
  if (cache.size > maxSize) {
    // Drop the oldest entry (Map iteration order is insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  if (!history) return envelope;
  return { ...envelope, streamerHistory: history };
}

/**
 * Drop cached enrichment for one (userId, opponent) pair so the
 * NEXT pre-game scouting card includes the freshly-uploaded game
 * in its LAST GAMES list. Called from the games ingest path right
 * after a successful upsert — without this, a rematch against the
 * same opponent within the 5-minute cache window would render
 * scouting data missing the most recent encounter.
 *
 * Drops every entry that matches the (userId, name) prefix under
 * the region-keyed scheme AND any entry under the pulse-id scheme
 * when ``pulseCharacterId`` is supplied — so a server-switch
 * rematch against the same opponent flushes both schemes.
 *
 * @param {Map<string, any>} cache
 * @param {string} userId
 * @param {string} opponentName
 * @param {string|number|null} [pulseCharacterId]
 */
function invalidateEnrichmentForOpponent(cache, userId, opponentName, pulseCharacterId) {
  if (!userId || !opponentName) return;
  const namePrefix = `${userId}|name:${opponentName.toLowerCase()}|`;
  const pcid =
    pulseCharacterId !== undefined
      && pulseCharacterId !== null
      && Number.isFinite(Number(pulseCharacterId))
      ? Number(pulseCharacterId)
      : null;
  const pulsePrefix = pcid !== null ? `${userId}|pulse:${pcid}|` : null;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(namePrefix)) {
      cache.delete(key);
      continue;
    }
    if (pulsePrefix !== null && key.startsWith(pulsePrefix)) {
      cache.delete(key);
    }
  }
}

module.exports = {
  pickStreamerRace,
  pickEnvelopeRegion,
  buildEnrichmentKey,
  enrichEnvelope,
  invalidateEnrichmentForOpponent,
};
