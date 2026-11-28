"use strict";

const { BuildIntentError, envelopeMatchup, isValidGameKey, normalizeRace } = require("./buildIntentCommon");
const DESKTOP_ROLL_CUTOFF_SEC = 30;

/**
 * The current game, when the desktop card can roll for it. The agent never
 * shows that card to a streamer who queued Random (its check-in hides
 * Random games), so a roll there would be saved and never seen.
 * @param {unknown} raw @returns {{gameKey:string,matchup:string}|null}
 */
function earlyRandomizerEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const envelope = /** @type {Record<string, any>} */ (raw);
  if (!isValidGameKey(envelope.gameKey) || envelope.isReplay === true || envelope.synthetic === true) return null;
  if (envelope.phase !== "match_loading" && !earlyPlayingPhase(envelope)) return null;
  if (!Array.isArray(envelope.players) || envelope.players.length !== 2
      || envelope.players.some((/** @type {any} */ player) => player?.type !== "user")) return null;
  if (normalizeRace(envelope.user?.race) === "Random") return null;
  const matchup = envelopeMatchup(envelope);
  return matchup ? { gameKey: envelope.gameKey, matchup } : null;
}

/**
 * @param {import("./buildIntentLive").BuildIntentLive} service
 * @param {string} userId @param {string} gameKey @param {Record<string,unknown>} randomizer
 */
async function allowAutomaticRoll(service, userId, gameKey, randomizer) {
  const unavailable = () => new BuildIntentError(409, "desktop_roll_unavailable", "Automatic desktop roll is unavailable.");
  if (randomizer.rollOnDesktop !== true) throw new BuildIntentError(409, "desktop_roll_disabled", "Automatic desktop roll is turned off.");
  if (await service.notifier.hasConnectedRandomizerWidget(userId) !== false) throw unavailable();
  requireTrustedEarlyGame(service, userId, gameKey);
}

/** @param {import("./buildIntentLive").BuildIntentLive} service @param {string} userId @param {string} gameKey */
function requireTrustedEarlyGame(service, userId, gameKey) {
  if (!service.broker?.isTrustedDeviceGame(userId, gameKey)
      || earlyRandomizerEnvelope(service.broker.latest(userId))?.gameKey !== gameKey) {
    throw new BuildIntentError(409, "stale_game", "This loading card no longer belongs to the current device game.");
  }
}

module.exports = { allowAutomaticRoll, earlyRandomizerEnvelope, requireTrustedEarlyGame };

/** @param {Record<string,any>} envelope */
function earlyPlayingPhase(envelope) {
  return (envelope.phase === "match_started" || envelope.phase === "match_in_progress")
    && Number.isFinite(envelope.displayTime) && envelope.displayTime >= 0
    && envelope.displayTime < DESKTOP_ROLL_CUTOFF_SEC;
}
