"use strict";

/**
 * The separate Twitch connects that add one write permission to the default
 * read-only link. Each has its own scope and its own stored consent, so
 * granting one never opts the streamer into another.
 */
/** @type {Readonly<Record<string, string>>} */
const TWITCH_PURPOSE_SCOPE = Object.freeze({
  predictions: "channel:manage:predictions",
  rewards: "channel:manage:redemptions",
  raids: "channel:manage:raids",
});

/** The stored consent flag a completed connect sets, by purpose. */
/** @type {Readonly<Record<string, string>>} */
const TWITCH_PURPOSE_CONSENT = Object.freeze({
  predictions: "predictionsConsent",
  rewards: "rewardsConsent",
  raids: "raidsConsent",
});

module.exports = { TWITCH_PURPOSE_SCOPE, TWITCH_PURPOSE_CONSENT };
