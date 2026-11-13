"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { REGIONS, TIER_REQUESTS, readBalanceTier } = require("./pulseBalanceAdapter");
const { summarizeBalance } = require("./pulseBalanceSummary");

const SOURCE = "https://sc2pulse.nephest.com/sc2/api/stats/balance-reports";
const USER_AGENT = "sc2tools.com balance-snapshot (+https://sc2tools.com/help)";
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const PACE_MS = 2_000;
const WARMUP_MS = 8 * 86_400_000;

/** @typedef {import("./pulseBalanceAdapter").TierRequest} TierRequest */
/** @typedef {import("./pulseBalanceAdapter").TierCube} TierCube */
/** @typedef {import("./seasons").SeasonEntry} SeasonEntry */

/** @param {string} code */
function collectorError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Wait for SC2Pulse's initial eight-day source exclusion in every region.
 * Keep the preceding season available while regions roll over on different days.
 * @param {SeasonEntry[]} items @param {number} now
 */
function balanceSeason(items, now) {
  const seasonStarts = new Map();
  for (const item of items) {
    if (!REGIONS.some(region => region === item.region)
      || !Number.isSafeInteger(item.battlenetId) || item.battlenetId <= 0 || !item.start) continue;
    const start = Date.parse(item.start);
    if (!Number.isFinite(start) || start > now) continue;
    const starts = seasonStarts.get(item.battlenetId) ?? new Map();
    starts.set(item.region, Math.max(start, starts.get(item.region) ?? -Infinity));
    seasonStarts.set(item.battlenetId, starts);
  }
  const eligible = [...seasonStarts].filter(([, starts]) =>
    REGIONS.every(region => starts.has(region) && now - starts.get(region) >= WARMUP_MS));
  return eligible.length ? Math.max(...eligible.map(([season]) => season)) : null;
}

/** @param {TierRequest} request @param {number} season */
function balanceUrl(request, season) {
  const url = new URL(SOURCE);
  url.search = new URLSearchParams({
    queue: "LOTV_1V1", teamType: "ARRANGED", league: request.league.toUpperCase(),
    tier: request.tier, season: String(season),
  }).toString();
  for (const region of REGIONS) url.searchParams.append("region", region);
  for (const race of ["PROTOSS", "TERRAN", "ZERG"]) url.searchParams.append("race", race);
  return url;
}

/** @param {Response} response */
async function boundedJson(response) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw collectorError("pulse_balance_http_error");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw collectorError("pulse_balance_body_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

/** @param {typeof fetch} fetchImpl @param {TierRequest} request @param {number} season @param {AbortSignal} signal */
async function fetchTier(fetchImpl, request, season, signal) {
  try {
    const response = await fetchImpl(balanceUrl(request, season), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      redirect: "error",
    });
    return readBalanceTier(await boundedJson(response), request, season);
  } catch (error) {
    signal.throwIfAborted();
    const source = /** @type {{code?:string,reason?:string,name?:string}|null} */ (error);
    throw Object.assign(new Error("SC2Pulse balance tier could not be collected"), {
      code: source?.code ?? "pulse_balance_request_failed",
      reason: source?.reason ?? (source?.name === "TimeoutError" ? "timeout" : undefined),
      league: request.league, division: request.division,
    });
  }
}

/**
 * @param {{
 *   catalog: () => Promise<{items:SeasonEntry[],fetchedAt:number|null}>,
 *   fetchImpl?:typeof fetch,
 *   wait?:(ms:number,signal:AbortSignal)=>Promise<void>,
 *   now?:()=>number,
 * }} deps
 */
function buildPulseBalanceCollector({ catalog, fetchImpl = fetch, wait = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now }) {
  /** @param {string} asOf @param {AbortSignal} signal */
  return async function collect(asOf, signal) {
    signal.throwIfAborted();
    const observedAt = now();
    const catalogResult = await catalog();
    const season = balanceSeason(catalogResult.items, observedAt);
    if (!season) throw collectorError("pulse_balance_season_unavailable");
    // Pace after catalog too when this call caused a refresh.
    if ((catalogResult.fetchedAt ?? -Infinity) >= observedAt) await wait(PACE_MS, signal);
    const tiers = [];
    for (const request of TIER_REQUESTS) {
      signal.throwIfAborted();
      if (tiers.length) await wait(PACE_MS, signal);
      tiers.push(await fetchTier(fetchImpl, request, season, signal));
    }
    const bundle = summarizeBalance({ season, asOf, tiers });
    return { bundle, tiers };
  };
}

module.exports = { USER_AGENT, RESPONSE_MAX_BYTES, balanceSeason, buildPulseBalanceCollector };
