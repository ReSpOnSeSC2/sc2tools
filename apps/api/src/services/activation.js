"use strict";

const ACTIVATION_QUERY_MAX_TIME_MS = 1500;
const CHAT_PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];

/** @param {unknown} value @returns {string|null} */
function activationTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

/** @param {unknown} value @returns {Array<'improve'|'stream'>} */
function activationGoals(value) {
  if (!Array.isArray(value) || value.length > 2 || value.some(goal => goal !== "improve" && goal !== "stream")) return [];
  return [...new Set(/** @type {Array<'improve'|'stream'>} */ (value))];
}

/** @param {import('mongodb').Document|null} user */
function hasIdentity(user) {
  const ids = Array.isArray(user?.pulseIds) ? user.pulseIds : [user?.pulseId];
  return ids.some(id => typeof id === "string" && id.trim().length > 0 && id.trim().length <= 64)
    || (typeof user?.battleTag === "string" && user.battleTag.trim().length > 0);
}

/** @param {unknown} [cause] */
function activationUnavailable(cause) {
  return Object.assign(new Error("activation_unavailable", { cause }), { status: 503, code: "activation_unavailable" });
}

class ActivationService {
  /** @param {{users:import('mongodb').Collection, games:import('mongodb').Collection,
   * customBuilds:import('mongodb').Collection, overlayTokens:import('mongodb').Collection}} db */
  constructor(db) { this.db = db; }

  /** Six projected commands, with the final owner check after the other reads.
   * No profile expansion, provider calls, token resolution or GET writes.
   * @param {string} userId */
  async get(userId) {
    const options = { projection: { _id: 1 }, maxTimeMS: ACTIVATION_QUERY_MAX_TIME_MS };
    try {
      const [identity, customBuild, checkIn, overlayLive, chatOn] = await Promise.all([
        this.db.users.findOne({ userId }, { ...options, projection: { _id: 0, pulseIds: 1, pulseId: 1, battleTag: 1 } }),
        this.db.customBuilds.findOne({ userId, deletedAt: { $exists: false } }, options),
        this.db.games.findOne({ userId, "buildIntent.status": "confirmed", _deleted: { $ne: true },
          _deletionPending: { $ne: true }, isResumedFromReplay: { $ne: true } }, options),
        this.db.overlayTokens.findOne({ userId, lastSeenAt: { $exists: true, $ne: null } }, options),
        this.db.users.findOne({ userId, $or: CHAT_PLATFORMS.map(platform => ({ [`preferences.multichat.${platform}.enabled`]: true })) }, options),
      ]);
      const metadata = await this.db.users.findOne({ userId, _gdprMutation: { $exists: false } }, {
        ...options, projection: { _id: 0, "preferences.onboarding.firstGameViewedAt": 1,
          "preferences.onboarding.goals": 1, "preferences.onboarding.levelUpDismissedAt": 1 },
      });
      if (!metadata) throw activationUnavailable();
      const onboarding = metadata.preferences?.onboarding;
      return { identity: hasIdentity(identity), firstGameViewed: activationTimestamp(onboarding?.firstGameViewedAt) !== null,
        customBuild: !!customBuild, checkIn: !!checkIn, overlayLive: !!overlayLive, chatOn: !!chatOn,
        goals: activationGoals(onboarding?.goals), levelUpDismissedAt: activationTimestamp(onboarding?.levelUpDismissedAt) };
    } catch (error) { throw activationUnavailable(error); }
  }
}

module.exports = { ActivationService, ACTIVATION_QUERY_MAX_TIME_MS, activationTimestamp, activationUnavailable };
