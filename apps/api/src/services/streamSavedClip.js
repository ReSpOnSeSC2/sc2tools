"use strict";

/** Longest clip name the Dock shows; a file name the agent builds is shorter. */
const SAVED_CLIP_NAME_MAX = 160;
/** Errors that mean a token cannot take a moment right now. The clip is still saved on the streamer's PC. */
const SKIPPED_TOKEN_CODES = new Set(["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"]);

/**
 * Turn the agent's report of a saved OBS replay-buffer clip into a clip
 * moment on each of the streamer's Stream Docks, so it is listed in Clips.
 *
 * @param {{
 *   engagement: Pick<import('./multichatEngagement').MultichatEngagementService, 'recordMoment'>,
 *   overlayTokens: Pick<import('./overlayTokens').OverlayTokensService, 'list'>,
 * }} deps
 * @returns {(userId: string, name: string) => Promise<number>} how many Docks listed it
 */
function savedClipRecorder({ engagement, overlayTokens }) {
  return async (userId, name) => {
    let listed = 0;
    for (const { token, revokedAt } of await overlayTokens.list(userId)) {
      if (!token || revokedAt) continue;
      try {
        await engagement.recordMoment(token, { kind: "clip-saved", reason: name });
        listed += 1;
      } catch (error) {
        const code = /** @type {{code?: string}} */ (error)?.code;
        if (!SKIPPED_TOKEN_CODES.has(String(code))) throw error;
      }
    }
    return listed;
  };
}

/**
 * A clip name the agent sent: one line of text, trimmed, within the limit.
 * @param {unknown} value
 * @returns {string|null} the name, or null when it is not acceptable
 */
function savedClipName(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return null;
  const name = value.trim();
  return name && Array.from(name).length <= SAVED_CLIP_NAME_MAX ? name : null;
}

module.exports = { savedClipRecorder, savedClipName, SAVED_CLIP_NAME_MAX };
