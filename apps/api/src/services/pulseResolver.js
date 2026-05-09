"use strict";

/**
 * Cloud-side SC2Pulse resolver.
 *
 * Faithful port of ``reveal-sc2-opponent-main/core/pulse_resolver.py``
 * — same algorithm, same disambiguation flow, same input/output
 * contract — but invoked from Node so the cloud's backfill cron and
 * any future server-side enrichment can recover an opponent's
 * canonical SC2Pulse character id without needing the agent in the
 * loop.
 *
 *   parseToonHandle("1-S2-1-267727")  →  { region: 1, realm: 1, bnid: 267727 }
 *   resolver.resolve({
 *     toonHandle: "1-S2-1-267727",
 *     displayName: "ReSpOnSe",
 *   })  →  Promise<string|null>
 *
 * Real outbound HTTP. No mocks, no stubs, no synthetic ids. The
 * external base URL is configurable for tests via
 * ``buildPulseResolver({ baseUrl })``; the production caller leaves
 * it on the SC2Pulse production endpoint.
 *
 * Caching policy mirrors the Python resolver but with explicit
 * TTLs:
 *   * Positive cache: 24 h (the canonical character id for a given
 *     toon doesn't change inside a season).
 *   * Negative cache: 30 m (so a player who appears on SC2Pulse a
 *     few minutes after their first ranked game gets retried
 *     instead of being permanently blackholed by an outage that
 *     happened to coincide with their first replay).
 *   * Per-region season-id cache: 6 h (seasons roll quarterly).
 *
 * Rate-limit handling: respects ``Retry-After`` on 429, falls back
 * to exponential backoff (2 s, 4 s, 8 s) up to 3 retries on any
 * 5xx / network failure. Hard per-call timeout via
 * ``SC2TOOLS_API_PULSE_TIMEOUT_SEC`` (default 8 s).
 */

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const QUEUE_1V1 = "LOTV_1V1";
const REGION_CODE_TO_NAME = Object.freeze({
  1: "US", 2: "EU", 3: "KR", 5: "CN",
});
const USER_AGENT = "sc2tools-api-pulse-resolver/1";
const HARD_RETRIES = 3;
const BACKOFF_MS = [2000, 4000, 8000];
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const SEASON_TTL_MS = 6 * 60 * 60 * 1000;
const LRU_MAX_ENTRIES = 5000;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Build a resolver bound to the given fetch implementation. The
 * returned object carries its own LRU caches, so callers should
 * keep one shared instance for the lifetime of the process to
 * benefit from cross-request memoization.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   logger?: import('pino').Logger,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 * }} [opts]
 */
function buildPulseResolver(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("buildPulseResolver: fetch implementation required");
  }
  const logger = opts.logger || NOOP_LOGGER;
  const baseUrl = (opts.baseUrl || PULSE_API_ROOT).replace(/\/+$/, "");
  const timeoutMs = clampTimeoutMs(opts.timeoutMs);
  const lookupCache = new LruCache(LRU_MAX_ENTRIES);
  const seasonCache = new LruCache(8); // one entry per region, max
  // Singleflight: collapse concurrent lookups of the same toon onto
  // one outbound resolver invocation. Without this a backfill batch
  // that hits the same toon twice (e.g. a user with two clan-tag
  // variants of the same opponent) would double-call SC2Pulse.
  /** @type {Map<string, Promise<string|null>>} */
  const inFlight = new Map();

  /**
   * Resolve a toon → pulseCharacterId. ``forceRefresh: true`` skips
   * both caches so the backfill cron can recover from a stale miss.
   * Never throws — a transient error is logged and surfaced as
   * ``null`` so the caller's row keeps the toon-only fallback.
   *
   * @param {{
   *   toonHandle: string,
   *   displayName?: string,
   *   forceRefresh?: boolean,
   * }} args
   * @returns {Promise<string|null>}
   */
  async function resolve(args) {
    const toonHandle = typeof args.toonHandle === "string"
      ? args.toonHandle.trim()
      : "";
    const displayName = typeof args.displayName === "string"
      ? args.displayName.trim()
      : "";
    if (!toonHandle) return null;
    const parsed = parseToonHandle(toonHandle);
    if (!parsed) return null;
    if (!args.forceRefresh) {
      const cached = lookupCache.get(toonHandle);
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return cached.value;
        }
        lookupCache.delete(toonHandle);
      }
    }
    const key = `${toonHandle}|${displayName.toLowerCase()}|${args.forceRefresh ? "f" : "c"}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const result = await doResolve(parsed, displayName);
        const ttl = result === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
        lookupCache.set(toonHandle, {
          value: result,
          expiresAt: Date.now() + ttl,
        });
        return result;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

  async function doResolve(parsed, displayName) {
    const { region, bnid } = parsed;
    const seasonId = await getLatestSeason(region);
    if (seasonId === null) {
      // Transient outage during the season lookup — surface a miss
      // but DON'T cache it; the next call gets another shot.
      return null;
    }
    if (!displayName) {
      // The advanced search endpoint requires a name term. Empty
      // display names happen for opponents whose row only had a
      // toon. Without something to search for we can't produce a
      // candidate list; treat as a cacheable miss.
      return null;
    }
    const candidates = await searchCandidates({
      region,
      seasonId,
      name: displayName,
    });
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    for (const cid of candidates) {
      const cidInt = Number.parseInt(String(cid), 10);
      if (!Number.isFinite(cidInt) || cidInt <= 0) continue;
      const matched = await confirmByBnid({
        candidateId: cidInt,
        region,
        expectedBnid: bnid,
      });
      if (matched) {
        const resolvedId = String(cidInt);
        logger.info(
          { region, bnid, pulseCharacterId: resolvedId },
          "pulse_resolver_resolved",
        );
        return resolvedId;
      }
    }
    return null;
  }

  async function getLatestSeason(region) {
    const cached = seasonCache.get(region);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const body = await fetchJson(`${baseUrl}/season/list/all`);
    const regionName = REGION_CODE_TO_NAME[region];
    if (!Array.isArray(body) || !regionName) return null;
    let best = null;
    for (const entry of body) {
      if (!entry || typeof entry !== "object") continue;
      const r = typeof entry.region === "string" ? entry.region.toUpperCase() : "";
      if (r !== regionName.toUpperCase()) continue;
      const bnid = entry.battlenetId;
      if (typeof bnid === "number" && (best === null || bnid > best)) {
        best = bnid;
      }
    }
    if (best !== null) {
      seasonCache.set(region, {
        value: best,
        expiresAt: Date.now() + SEASON_TTL_MS,
      });
    }
    return best;
  }

  async function searchCandidates({ region, seasonId, name }) {
    const regionName = REGION_CODE_TO_NAME[region];
    if (!regionName) return [];
    const url =
      `${baseUrl}/character/search/advanced`
      + `?season=${encodeURIComponent(String(seasonId))}`
      + `&region=${encodeURIComponent(regionName)}`
      + `&queue=${encodeURIComponent(QUEUE_1V1)}`
      + `&name=${encodeURIComponent(name)}`
      + `&caseSensitive=true`;
    const body = await fetchJson(url);
    return Array.isArray(body) ? body : [];
  }

  async function confirmByBnid({ candidateId, region, expectedBnid }) {
    const regionName = REGION_CODE_TO_NAME[region];
    if (!regionName) return false;
    const body = await fetchJson(
      `${baseUrl}/character/${encodeURIComponent(String(candidateId))}/teams`,
    );
    if (!Array.isArray(body)) return false;
    for (const team of body) {
      if (!team || typeof team !== "object") continue;
      const members = Array.isArray(team.members) ? team.members : [];
      for (const member of members) {
        if (!member || typeof member !== "object") continue;
        const ch = member.character || {};
        const chRegion = typeof ch.region === "string" ? ch.region.toUpperCase() : "";
        if (chRegion === regionName.toUpperCase() && ch.battlenetId === expectedBnid) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * GET ``url`` and return parsed JSON, or null on any failure.
   * Retries network errors / 5xx / 429 with exponential backoff;
   * 4xx (other than 408 / 429) are permanent and short-circuit.
   *
   * @param {string} url
   * @returns {Promise<any|null>}
   */
  async function fetchJson(url) {
    let lastErr = null;
    for (let attempt = 0; attempt < HARD_RETRIES; attempt += 1) {
      const ctl = new AbortController();
      const timeoutHandle = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        logger.debug({ url, attempt }, "pulse_resolver_fetch");
        const res = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": USER_AGENT,
          },
          signal: ctl.signal,
        });
        if (res.status === 429) {
          const wait = retryAfterMs(res, attempt);
          logger.debug({ url, status: 429, wait }, "pulse_resolver_rate_limited");
          await sleep(wait);
          continue;
        }
        if (res.status >= 500) {
          await sleep(BACKOFF_MS[attempt] || 8000);
          continue;
        }
        if (res.status >= 400) {
          // Non-retriable client error (404 on a removed character,
          // 400 on a malformed query). Surface as null so the
          // caller treats it as a miss.
          logger.debug({ url, status: res.status }, "pulse_resolver_client_error");
          return null;
        }
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (err) {
          logger.warn({ url, err }, "pulse_resolver_parse_failed");
          return null;
        }
      } catch (err) {
        lastErr = err;
        const isLast = attempt === HARD_RETRIES - 1;
        if (isLast) break;
        await sleep(BACKOFF_MS[attempt] || 8000);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
    logger.warn({ url, err: lastErr && lastErr.message }, "pulse_resolver_fetch_failed");
    return null;
  }

  return {
    resolve,
    parseToonHandle,
    /** @internal — exposed for tests */
    _internal: { lookupCache, seasonCache },
  };
}

/**
 * Split ``"1-S2-1-267727"`` into ``{ region, realm, bnid }`` or
 * return null on a malformed / unsupported handle. Matches the
 * Python resolver's behaviour exactly so server- and agent-side
 * resolvers accept the same inputs.
 *
 * @param {string|null|undefined} toon
 * @returns {{ region: number, realm: number, bnid: number } | null}
 */
function parseToonHandle(toon) {
  if (typeof toon !== "string") return null;
  const parts = toon.trim().split("-");
  if (parts.length !== 4 || parts[1].toUpperCase() !== "S2") return null;
  const region = Number.parseInt(parts[0], 10);
  const realm = Number.parseInt(parts[2], 10);
  const bnid = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(region) || !Number.isFinite(realm) || !Number.isFinite(bnid)) {
    return null;
  }
  if (!REGION_CODE_TO_NAME[region] || bnid <= 0) return null;
  return { region, realm, bnid };
}

function clampTimeoutMs(raw) {
  const envRaw = (process.env.SC2TOOLS_API_PULSE_TIMEOUT_SEC || "").trim();
  if (envRaw) {
    const n = Number.parseFloat(envRaw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_TIMEOUT_MS;
}

function retryAfterMs(res, attempt) {
  const header = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("retry-after")
    : null;
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.floor(seconds * 1000));
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.max(0, Math.min(60_000, date - Date.now()));
    }
  }
  return BACKOFF_MS[attempt] || 8000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Tiny LRU bounded by entry count. Suitable for in-process
 * memoization where the working set is small and we don't want a
 * dedicated dependency.
 */
class LruCache {
  /** @param {number} max */
  constructor(max) {
    this.max = Math.max(1, max | 0);
    /** @type {Map<any, any>} */
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER,
};

module.exports = {
  buildPulseResolver,
  parseToonHandle,
  // Exported for tests.
  __internal: { LruCache, retryAfterMs, clampTimeoutMs },
};
