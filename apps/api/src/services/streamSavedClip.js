"use strict";

/** Longest clip name the Dock shows; a file name the agent builds is shorter. */
const SAVED_CLIP_NAME_MAX = 160;
/** How far back, and how far ahead, a game's end may be stamped; anything else is stamped with the time it arrived. */
const ENDED_AT_PAST_MS = 6 * 60 * 60 * 1000;
const ENDED_AT_FUTURE_MS = 60 * 1000;
/** Errors that mean a token cannot take a moment right now. The clip is still saved on the streamer's PC. */
const SKIPPED_TOKEN_CODES = new Set(["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"]);

/**
 * Turn the agent's report of a saved OBS replay-buffer clip into a clip
 * moment on each of the streamer's Stream Docks, so it is listed in Clips.
 *
 * @param {{
 *   engagement: Pick<import('./multichatEngagement').MultichatEngagementService, 'recordMoment'>,
 *   overlayTokens: Pick<import('./overlayTokens').OverlayTokensService, 'list'>,
 *   now?: () => number,
 * }} deps
 * @returns {(userId: string, name: string, endedAtMs?: unknown) => Promise<number>} how many Docks listed it
 */
function savedClipRecorder({ engagement, overlayTokens, now = Date.now }) {
  return async (userId, name, endedAtMs) => {
    const at = savedClipEndedAt(endedAtMs, now());
    let listed = 0;
    for (const { token, revokedAt } of await overlayTokens.list(userId)) {
      if (!token || revokedAt) continue;
      try {
        await engagement.recordMoment(token, { kind: "clip-saved", reason: name, ...(at === null ? {} : { atMs: at }) });
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

/**
 * When the clip's game ended, as the agent reported it, so the Dock row and its
 * VOD link point at the ending and not at the moment the file was filed.
 * @param {unknown} value epoch milliseconds
 * @param {number} now epoch milliseconds
 * @returns {number|null} the time, or null when it is missing or not plausible
 */
function savedClipEndedAt(value, now) {
  return typeof value === "number" && Number.isFinite(value) && value >= now - ENDED_AT_PAST_MS
    && value <= now + ENDED_AT_FUTURE_MS ? Math.round(value) : null;
}

module.exports = { savedClipRecorder, savedClipName, savedClipEndedAt, SAVED_CLIP_NAME_MAX };
