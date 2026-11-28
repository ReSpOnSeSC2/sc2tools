"use strict";

/**
 * The one paced door to SC2Pulse for the public ladder features (the ladder
 * VOD finder and the pros board). SC2Pulse is a free, single-maintainer
 * service, so every call leaves at least `PACE_MS` after the one before it,
 * whoever asked, and a caller that would wait too long is refused rather than
 * queued, so an outage cannot build a backlog.
 */

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const REQUEST_TIMEOUT_MS = 8000;
/** At most one SC2Pulse call a second, however many visitors search. */
const PACE_MS = 1100;
const DEFAULT_USER_AGENT = "sc2tools.com (+https://sc2tools.com)";

class PulseBusyError extends Error {
  constructor() {
    super("pulse_busy");
    this.code = "busy";
  }
}

class PulseClient {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   * }} [options]
   */
  constructor({
    fetchImpl = fetch,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.nextCallAt = 0;
  }

  /**
   * One GET under the shared pace.
   *
   * @param {string} path the endpoint under `/sc2/api`, such as `/matches`
   * @param {URLSearchParams} query
   * @param {{ maxWaitMs: number, userAgent?: string }} options how long this caller may wait for its turn, and the name it gives
   * @returns {Promise<unknown>} the parsed JSON body
   * @throws {PulseBusyError} the turn is further away than `maxWaitMs`
   */
  async get(path, query, { maxWaitMs, userAgent = DEFAULT_USER_AGENT }) {
    await this.waitForTurn(maxWaitMs);
    const response = await this.fetchImpl(`${PULSE_API_ROOT}${path}?${query}`, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`pulse_http_${response.status}`);
    return response.json();
  }

  /** Reserves the next call slot; refuses when the wait would pass `maxWaitMs`. @param {number} maxWaitMs */
  async waitForTurn(maxWaitMs) {
    const now = this.now();
    const slot = Math.max(now, this.nextCallAt);
    if (slot - now > maxWaitMs) throw new PulseBusyError();
    this.nextCallAt = slot + PACE_MS;
    if (slot > now) await this.sleep(slot - now);
  }
}

module.exports = { PulseClient, PulseBusyError, PACE_MS };
