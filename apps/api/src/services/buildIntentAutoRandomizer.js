"use strict";

const { BuildIntentError, isValidGameKey, matchupFromRaces, normalizeRace } = require("./buildIntentCommon");
const DESKTOP_ROLL_CUTOFF_SEC = 30;

/** @param {unknown} raw @returns {{gameKey:string,matchup:string}|null} */
function earlyRandomizerEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const envelope = /** @type {Record<string, any>} */ (raw);
  if (!isValidGameKey(envelope.gameKey) || envelope.isReplay === true || envelope.synthetic === true) return null;
  if (envelope.phase !== "match_loading" && !earlyPlayingPhase(envelope)) return null;
  if (!Array.isArray(envelope.players) || envelope.players.length !== 2
      || envelope.players.some((/** @type {any} */ player) => player?.type !== "user")) return null;
  const matchup = matchupFromRaces(normalizeRace(envelope.user?.race), normalizeRace(envelope.opponent?.race));
  return matchup ? { gameKey: envelope.gameKey, matchup } : null;
}

/**
 * @param {import("./buildIntentLive").BuildIntentLive} service
 * @param {string} userId @param {string} gameKey @param {Record<string,unknown>} randomizer
 */
async function allowAutomaticRoll(service, userId, gameKey, randomizer) {
  const unavailable = () => new BuildIntentError(409, "desktop_roll_unavailable", "Automatic desktop roll is unavailable.");
  if (randomizer.rollOnDesktop !== true) throw unavailable();
  if (await service.notifier.hasConnectedRandomizerWidget(userId) !== false) throw unavailable();
  if (!service.broker?.isTrustedDeviceGame(userId, gameKey)
      || earlyRandomizerEnvelope(service.broker.latest(userId))?.gameKey !== gameKey) throw unavailable();
}

module.exports = { allowAutomaticRoll, earlyRandomizerEnvelope };

/** @param {Record<string,any>} envelope */
function earlyPlayingPhase(envelope) {
  return (envelope.phase === "match_started" || envelope.phase === "match_in_progress")
    && Number.isFinite(envelope.displayTime) && envelope.displayTime >= 0
    && envelope.displayTime < DESKTOP_ROLL_CUTOFF_SEC;
}
