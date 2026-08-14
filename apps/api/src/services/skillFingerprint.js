"use strict";

/**
 * Stable public import for the replay-derived playstyle fingerprint.
 * The implementation is split out so its absolute heuristic contract stays
 * separate from the league-percentile benchmark service.
 */
module.exports = require("./playerStyleFingerprint");
