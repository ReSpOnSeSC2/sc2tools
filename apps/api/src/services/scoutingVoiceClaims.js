"use strict";

/** @param {unknown} key @returns {key is string} */
function validScoutingVoiceGameKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 200
    && key === key.trim() && !/[\u0000-\u001f\u007f]/.test(key);
}

/** Shared by native and browser readers in the single-instance live broker.
 * Keep receipts through reconnects and transient menu ticks. At capacity, deny
 * new claims instead of evicting an active game's duplicate protection. */
class ScoutingVoiceClaims {
  constructor() {
    /** @type {Map<string, number>} */
    this.receipts = new Map();
  }

  /** @param {string} userId @param {string} gameKey @returns {boolean} */
  claim(userId, gameKey) {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, at] of this.receipts) {
      if (at > cutoff) break;
      this.receipts.delete(key);
    }
    const key = JSON.stringify([userId, gameKey]);
    if (this.receipts.has(key) || this.receipts.size >= 4096) return false;
    this.receipts.set(key, now);
    return true;
  }

  clear() { this.receipts.clear(); }
}

module.exports = { ScoutingVoiceClaims, validScoutingVoiceGameKey };
