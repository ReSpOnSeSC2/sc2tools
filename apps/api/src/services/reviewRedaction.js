"use strict";

/**
 * Replay Review Exchange — the ONLY place that decides what a public
 * review payload may contain.
 *
 * Privacy model (docs/reviews.md):
 *   - The opponent is a third party who never consented. Nothing that
 *     can identify them leaves the server: no display name, battle tag,
 *     clan, toon handle, pulse id, exact MMR, replay file, stream links,
 *     APM curve (it carries player names) or ``player_stats``.
 *   - ``gameId`` is private too: agents that cannot read a replay's
 *     native id build one as ``date|OpponentName|map|length``.
 *   - The asker appears either under their display name or as
 *     "Anonymous <Race>". MMR is only ever shown rounded to 100.
 *   - Chat is not extracted from replays, so there is nothing to redact
 *     there. Keep it that way.
 *
 * Every function here builds its output from an explicit allow-list —
 * never by spreading service output — so a new field added upstream
 * cannot leak by default.
 */

const {
  publicMacroBreakdown,
  boundedString,
  boundedNumber,
} = require("../routes/publicReplays");
const {
  bandFromMmr,
  approximateMmr,
  formatApproxMmr,
} = require("../util/leagueBands");

const RACES = Object.freeze(["Protoss", "Terran", "Zerg", "Random"]);

/**
 * @param {unknown} raw
 * @returns {"Protoss"|"Terran"|"Zerg"|"Random"|null}
 */
function normalizeRace(raw) {
  if (typeof raw !== "string") return null;
  const head = raw.trim().charAt(0).toUpperCase();
  if (head === "P") return "Protoss";
  if (head === "T") return "Terran";
  if (head === "Z") return "Zerg";
  if (head === "R") return "Random";
  return null;
}

/**
 * @param {unknown} myRace
 * @param {unknown} oppRace
 * @returns {string | null} e.g. "PvZ"
 */
function matchupFor(myRace, oppRace) {
  const mine = normalizeRace(myRace);
  const theirs = normalizeRace(oppRace);
  if (!mine || !theirs || mine === "Random" || theirs === "Random") return null;
  return `${mine.charAt(0)}v${theirs.charAt(0)}`;
}

/**
 * @param {unknown} raw
 * @returns {"Win"|"Loss"|"Draw"|null}
 */
function normalizeResult(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "win" || value === "victory") return "Win";
  if (value === "loss" || value === "defeat") return "Loss";
  if (value === "draw" || value === "tie") return "Draw";
  return null;
}

/**
 * "Opponent (Zerg, ~4,100 MMR)". The only way the opponent is ever
 * named in public.
 *
 * @param {{race?: unknown, mmr?: unknown}} opponent
 */
function opponentLabel(opponent) {
  const race = normalizeRace(opponent?.race);
  const mmr = formatApproxMmr(approximateMmr(opponent?.mmr));
  const parts = [race, mmr].filter(Boolean);
  return parts.length ? `Opponent (${parts.join(", ")})` : "Opponent";
}

/**
 * @param {{mode: "named"|"anonymous", name?: string|null, race?: unknown}} asker
 */
function askerLabel(asker) {
  if (asker.mode === "named" && asker.name) return asker.name;
  const race = normalizeRace(asker.race);
  return race && race !== "Random" ? `Anonymous ${race}` : "Anonymous player";
}

/**
 * Freeze the public, redacted facts about one of the asker's games at
 * posting time. ``game`` is the owner-private slim row; the output is
 * safe to store on the public request document.
 *
 * @param {Record<string, any>} game
 */
function buildGameSnapshot(game) {
  const opponent = game && typeof game.opponent === "object" && game.opponent
    ? game.opponent
    : {};
  const myRace = normalizeRace(game.myRace);
  const oppRace = normalizeRace(opponent.race);
  const askerMmr = approximateMmr(game.myMmr);
  const oppMmr = approximateMmr(opponent.mmr);
  const askerBand = bandFromMmr(game.myMmr);
  const opponentBand = bandFromMmr(opponent.mmr);
  return {
    matchup: matchupFor(myRace, oppRace),
    myRace,
    oppRace,
    map: boundedString(game.map, 120),
    result: normalizeResult(game.result),
    durationSec: boundedNumber(game.durationSec, 0, 86_400, true),
    playedAt: game.date instanceof Date || typeof game.date === "string"
      ? safeDate(game.date)
      : null,
    askerBand: askerBand ? { id: askerBand.id, label: askerBand.label } : null,
    askerMmr,
    opponentBand: opponentBand ? { id: opponentBand.id, label: opponentBand.label } : null,
    opponentMmr: oppMmr,
    opponentLabel: opponentLabel({ race: oppRace, mmr: opponent.mmr }),
    myBuild: boundedString(game.myBuild, 120),
    oppStrategy: boundedString(opponent.strategy, 120),
    macroScore: boundedNumber(game.macroScore, 0, 100, false),
  };
}

/** @param {unknown} raw */
function safeDate(raw) {
  const value = new Date(/** @type {any} */ (raw));
  return Number.isNaN(value.getTime()) ? null : value;
}

/**
 * Macro breakdown for a review: exactly the public-replay allow-list
 * (drops ``player_stats``, ``unit_timeline``, bases and any unknown key).
 *
 * @param {unknown} raw
 */
function reviewMacroBreakdown(raw) {
  return publicMacroBreakdown(raw);
}

/**
 * Build order for a review. Mirrors ``publicBuildOrder`` but keeps
 * ``complete_time`` (the replay roster needs it for upgrade completion)
 * and never returns ``game_id`` or the opponent's name.
 *
 * @param {unknown} raw
 * @param {{opponentLabel: string}} opts
 */
function reviewBuildOrder(raw, opts) {
  const source = objectOrEmpty(raw);
  if (source.ok !== true) return null;
  return {
    ok: true,
    my_build: boundedString(source.my_build, 200),
    my_race: normalizeRace(source.my_race),
    opp_strategy: boundedString(source.opp_strategy, 200),
    opponent: opts.opponentLabel,
    opp_race: normalizeRace(source.opp_race),
    map: boundedString(source.map, 200),
    result: normalizeResult(source.result),
    events: reviewBuildEvents(source.events),
    early_events: reviewBuildEvents(source.early_events),
    opp_events: reviewBuildEvents(source.opp_events),
    opp_early_events: reviewBuildEvents(source.opp_early_events),
    my_status: validBuildStatus(source.my_status),
    opp_status: validBuildStatus(source.opp_status),
  };
}

/** @param {unknown} raw */
function reviewBuildEvents(raw) {
  return arrayOrEmpty(raw).slice(0, 2_000).flatMap((entry) => {
    const row = objectOrEmpty(entry);
    const time = boundedNumber(row.time, 0, 86_400, false);
    const name = boundedString(row.name, 160);
    if (time === null || !name) return [];
    /** @type {Record<string, any>} */
    const out = {
      time,
      time_display: boundedString(row.time_display, 16),
      name,
      display: boundedString(row.display, 160),
      race: boundedString(row.race, 24),
      category: boundedString(row.category, 40),
      tier: boundedNumber(row.tier, 0, 20, true),
      is_building: row.is_building === true,
    };
    const complete = boundedNumber(row.complete_time, 0, 86_400, false);
    if (complete !== null) out.complete_time = complete;
    return [out];
  });
}

/** @param {unknown} raw */
function validBuildStatus(raw) {
  return raw === "ok" || raw === "empty" || raw === "not_extracted"
    ? raw
    : undefined;
}

/**
 * Top-level keys of the v3–v7 map playback payload (mirrors what the web
 * sanitizer ``sanitizeMapPlayback`` reads). Units/buildings carry
 * ``owner: "me"|"opp"`` only; there are no player names in the format.
 * Anything else — including the owner-only ``rebuild`` job (it carries a
 * socket id) and ``replaySha256`` — is dropped.
 */
const PLAYBACK_KEYS = Object.freeze([
  "v",
  "mapName",
  "gameLength",
  "bounds",
  "spawns",
  "battles",
  "buildings",
  "units",
  "resources",
  "casts",
  "effects",
  "creep",
  "stats",
  "fidelity",
  "terminalAttackInclusive",
]);

/**
 * @param {unknown} raw  ``perGame.mapPlayback`` output
 * @returns {Record<string, unknown> | null}
 */
function reviewPlayback(raw) {
  const source = objectOrEmpty(raw);
  if (source.ok !== true || !source.bounds) return null;
  /** @type {Record<string, unknown>} */
  const out = { ok: true };
  for (const key of PLAYBACK_KEYS) {
    if (source[key] !== undefined) out[key] = stripIdentityKeys(source[key]);
  }
  return out;
}

/**
 * Keys that name a person anywhere inside nested playback data. Unit and
 * building rows use ``name`` for the UNIT type ("Marine"), so ``name``
 * itself is allowed; these never are.
 */
const IDENTITY_KEYS = new Set([
  "player",
  "players",
  "playerName",
  "displayName",
  "battleTag",
  "clan",
  "clanTag",
  "toon",
  "toonHandle",
  "handle",
  "pulseId",
  "pulseCharacterId",
  "userId",
  "gameId",
]);

/**
 * Recursively drop identity-shaped keys. Defence in depth for the
 * agent-authored, ``additionalProperties: true`` playback blob.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function stripIdentityKeys(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripIdentityKeys(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (IDENTITY_KEYS.has(key)) continue;
    out[key] = stripIdentityKeys(item, depth + 1);
  }
  return out;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Segmented-playback manifest for a review. Segment bytes are
 * integrity-hashed by the agent and forwarded verbatim (they contain
 * only ``owner``-keyed playback); the manifest is re-built from an
 * allow-list.
 *
 * @param {unknown} raw  ``playbackArtifacts.getManifest`` output
 */
function reviewPlaybackManifest(raw) {
  const response = objectOrEmpty(raw);
  const manifest = objectOrEmpty(response.manifest);
  if (response.ok !== true || typeof response.artifactId !== "string" || !SHA256_RE.test(response.artifactId)) {
    return null;
  }
  const segments = arrayOrEmpty(manifest.segments).slice(0, 512).map((entry) => {
    const row = objectOrEmpty(entry);
    return {
      index: row.index,
      start: row.start,
      end: row.end,
      sizeBytes: row.sizeBytes,
      points: row.points,
      sha256: row.sha256,
    };
  });
  return {
    ok: true,
    artifactId: response.artifactId,
    manifest: {
      schema: manifest.schema,
      replaySha256: manifest.replaySha256,
      sourceArtifactSha256: manifest.sourceArtifactSha256,
      mapName: boundedString(manifest.mapName, 200),
      gameLength: manifest.gameLength,
      fidelity: stripIdentityKeys(manifest.fidelity),
      segments,
    },
  };
}

/** @param {unknown} raw @returns {Record<string, any>} */
function objectOrEmpty(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, any>} */ (raw)
    : {};
}

/** @param {unknown} raw @returns {any[]} */
function arrayOrEmpty(raw) {
  return Array.isArray(raw) ? raw : [];
}

module.exports = {
  RACES,
  normalizeRace,
  matchupFor,
  normalizeResult,
  opponentLabel,
  askerLabel,
  buildGameSnapshot,
  reviewMacroBreakdown,
  reviewBuildOrder,
  reviewPlayback,
  reviewPlaybackManifest,
  stripIdentityKeys,
};
