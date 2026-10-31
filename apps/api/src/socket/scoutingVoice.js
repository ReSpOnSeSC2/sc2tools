"use strict";
const { validScoutingVoiceGameKey } = require("../services/scoutingVoiceClaims");

/** @param {import('socket.io').Socket} socket
 * @param {{
 *   claimScoutingVoice?: (userId: string, gameKey: string) => boolean,
 *   validateOverlayToken?: (userId: string, token: string) => Promise<boolean>,
 *   resolveOverlayToken?: (token: string) => Promise<{userId: string}|null>,
 * }} opts */
function attachScoutingVoiceClaim(socket, opts) {
  let lastAttemptAt = 0;
  socket.on("overlay:claimScoutingVoice", async (payload, ack) => {
    if (typeof ack !== "function") return;
    const descriptor = socket.data.overlayPresence;
    const eligibleSurface = descriptor?.surface === "all-in-one"
      || (descriptor?.surface === "widget" && descriptor.widget === "scouting");
    const userId = socket.data.overlayUserId;
    const token = socket.data.overlayToken;
    const gameKey = payload?.gameKey;
    const now = Date.now();
    if (!opts.claimScoutingVoice || !eligibleSurface || socket.data.overlayControlOnly
      || !userId || !token || !validScoutingVoiceGameKey(gameKey)
      || now - lastAttemptAt < 1000) {
      ack({ granted: false });
      return;
    }
    lastAttemptAt = now;
    try {
      const valid = opts.validateOverlayToken
        ? await opts.validateOverlayToken(userId, token)
        : (await opts.resolveOverlayToken?.(token))?.userId === userId;
      if (!valid || !socket.connected) {
        ack({ granted: false });
        return;
      }
      ack({ granted: opts.claimScoutingVoice(userId, gameKey) });
    } catch {
      ack({ granted: false });
    }
  });
}

module.exports = { attachScoutingVoiceClaim };
