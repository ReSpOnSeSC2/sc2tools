"use strict";

const { BUILD_INTENT } = require("../config/constants");
const { BuildIntentError, normalizeRace, matchupFromRaces, holdRemainingMs, overlayPayload } = require("./buildIntentCommon");
const { readBuildIntentPrefs, randomizerPool } = require("./buildIntentPrefs");

/** @param {string} value */
function seededRandom(value) {
  let seed = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    seed ^= value.charCodeAt(index);
    seed = Math.imul(seed, 0x01000193);
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {import('./buildIntentLive').BuildIntentLive} service @param {string} userId @param {string} gameKey @param {string|null} [expectedMatchup] */
function currentEnvelope(service, userId, gameKey, expectedMatchup = null) {
  const latest = /** @type {Record<string, any>|null} */ (service.broker?.latest(userId));
  if (!latest || service.broker?.currentGameKey(userId) !== gameKey
      || latest.gameKey !== gameKey || latest.isReplay === true
      || !["match_loading", "match_started", "match_in_progress"].includes(latest.phase)) {
    throw new BuildIntentError(409, "stale_game", "This game is no longer current. Refresh the Companion.");
  }
  if (Array.isArray(latest.players) && (latest.players.length !== 2
      || latest.players.some((/** @type {any} */ player) => player?.type === "computer"))) {
    throw new BuildIntentError(409, "not_eligible", "The randomizer needs a one-on-one match.");
  }
  if (typeof latest.receivedAt === "number" && (!Number.isFinite(latest.receivedAt)
      || Math.abs(service.now() - latest.receivedAt) > 30000)) {
    throw new BuildIntentError(409, "stale_game", "The live game connection is stale. Refresh the Companion.");
  }
  if (expectedMatchup && matchupFromRaces(normalizeRace(latest.user?.race), normalizeRace(latest.opponent?.race)) !== expectedMatchup) {
    throw new BuildIntentError(409, "matchup_changed", "The current matchup changed. Refresh before rolling.");
  }
  return latest;
}

/** @param {Record<string, any>} config @param {string} seed */
function selectedBuildId(config, seed) {
  if (!Array.isArray(config.builds) || config.builds.length > 500) return null;
  /** @type {Map<string, {id:string,weight:number}>} */
  const unique = new Map();
  for (const raw of config.builds) {
    if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 200
        || typeof raw.name !== "string" || !raw.name.trim()) continue;
    const number = Number(raw.weight);
    unique.set(raw.id, { id: raw.id, weight: config.useCustomWeights === true ? (Number.isFinite(number) && number > 0 ? number : 0) : 1 });
  }
  const builds = [...unique.values()];
  if (!builds.length) return null;
  const total = builds.reduce((sum, build) => sum + build.weight, 0);
  const picked = seededRandom(seed)() * (total > 0 ? total : builds.length);
  let cumulative = 0;
  for (const build of builds) {
    cumulative += total > 0 ? build.weight : 1;
    if (picked < cumulative) return build.id;
  }
  return builds[builds.length - 1].id;
}

/**
 * @param {import('./buildIntentLive').BuildIntentLive} service
 * @param {string} userId
 * @param {string} matchup
 * @param {Record<string, any>} config
 * @param {string} gameKey
 */
async function resolveAvailableBuild(service, userId, matchup, config, gameKey) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const options = await service.options.forMatchup(userId, matchup);
    const availableKeys = new Set(options.builds.map((build) => build.key));
    const builds = [];
    for (const build of Array.isArray(config.builds) && config.builds.length <= 500 ? config.builds : []) {
      if (build && availableKeys.has(build.id)) builds.push(build);
    }
    const buildId = selectedBuildId({ ...config, builds }, `${matchup}:${gameKey}`);
    const ref = buildId ? await service.options.resolveKey(userId, matchup, buildId) : null;
    if (ref) return ref;
    service.options.invalidate(userId);
  }
  return null;
}

/**
 * @param {import('./buildIntentLive').BuildIntentLive} service
 * @param {string} userId
 * @param {string} gameKey
 * @param {{matchup:string,releaseHold:boolean,revealInWidget?:boolean}} body
 */
async function nativeRandomizerRoll(service, userId, gameKey, body) {
  let latest = currentEnvelope(service, userId, gameKey);
  const matchup = matchupFromRaces(normalizeRace(latest.user?.race), normalizeRace(latest.opponent?.race));
  if (!matchup || matchup !== body.matchup) {
    throw new BuildIntentError(409, "matchup_changed", "The current matchup changed. Refresh before rolling.");
  }
  let doc = await service.collection.findOne({ userId, gameKey });
  if (!doc) {
    doc = await service._upsert(userId, gameKey, {
      myRace: normalizeRace(latest.user?.race), oppRace: normalizeRace(latest.opponent?.race),
      oppName: typeof latest.opponent?.name === "string" ? latest.opponent.name : null,
    }, false);
  }
  if (doc.gameId) throw await service._alreadyBound(userId, gameKey);
  if (doc.declared) throw new BuildIntentError(409, "build_declared", "Your declared build is already selected for this game.");
  if (doc.randomizer) return service._state(userId, doc);
  const prefs = await readBuildIntentPrefs(service.users, userId);
  const pool = randomizerPool(prefs.randomizer, matchup);
  if (!pool.enabled) throw new BuildIntentError(409, "randomizer_disabled", "Enable the randomizer and select at least one build for this matchup.");
  latest = currentEnvelope(service, userId, gameKey, matchup);
  if (!body.releaseHold && latest.phase === "match_loading"
      && (holdRemainingMs(doc.hold, service.now()) > 0 || (prefs.checkin.enabled && prefs.checkin.askAtLoading))) {
    throw new BuildIntentError(409, "hold_active", "Waiting for the loading check-in. Choose Roll now or wait for the match to start.");
  }
  const config = /** @type {Record<string, any>} */ (prefs.randomizer).matchups[matchup];
  const ref = await resolveAvailableBuild(service, userId, matchup, config, gameKey);
  if (!ref) throw new BuildIntentError(409, "unknown_build", "No available builds remain in this pool. Edit the pool and try again.");
  currentEnvelope(service, userId, gameKey, matchup);
  const currentPrefs = await readBuildIntentPrefs(service.users, userId);
  const currentConfig = /** @type {Record<string, any>} */ (currentPrefs.randomizer).matchups?.[matchup];
  if (!randomizerPool(currentPrefs.randomizer, matchup).enabled
      || !currentConfig || JSON.stringify([currentConfig.useCustomWeights, currentConfig.builds]) !== JSON.stringify([config.useCustomWeights, config.builds])) {
    throw new BuildIntentError(409, "pool_changed", "The randomizer pool changed. Refresh before rolling.");
  }
  const finalEnvelope = currentEnvelope(service, userId, gameKey, matchup);
  if (!body.releaseHold && finalEnvelope.phase === "match_loading" && currentPrefs.checkin.enabled && currentPrefs.checkin.askAtLoading) {
    throw new BuildIntentError(409, "hold_active", "Waiting for the loading check-in. Choose Roll now or wait for the match to start.");
  }
  const now = new Date(service.now());
  const updated = await service.collection.findOneAndUpdate(
    { userId, gameKey, gameId: null, randomizer: null, declared: null },
    { $set: {
      randomizer: { ...ref, at: now, verifiedPool: true, native: body.revealInWidget !== true,
                    widgetReveal: body.revealInWidget === true },
      hold: { ...(doc.hold || {}), released: true },
      expiresAt: new Date(now.getTime() + BUILD_INTENT.LIVE_ANSWERED_TTL_MS), updatedAt: now,
    } },
    { returnDocument: "after" },
  );
  if (!updated) {
    const winner = await service.collection.findOne({ userId, gameKey });
    if (winner?.declared) throw new BuildIntentError(409, "build_declared", "Your declared build is already selected for this game.");
    if (winner?.randomizer && !winner.gameId) return service._state(userId, winner);
    throw await service._alreadyBound(userId, gameKey);
  }
  service.options.invalidate(userId);
  await service.notifier.overlay(userId, overlayPayload(updated, service.now()));
  service.notifier.changed(userId, { gameKey });
  return service._state(userId, updated);
}

module.exports = { nativeRandomizerRoll, selectedBuildId, seededRandom };
