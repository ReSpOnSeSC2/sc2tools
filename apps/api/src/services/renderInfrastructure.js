"use strict";

const RENDER_API_URL = "https://api.render.com/v1";
const DEFAULT_TIMEOUT_MS = 8 * 1000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const METRIC_WINDOW_MS = 60 * 60 * 1000;
const METRIC_RESOLUTION_SECONDS = 300;
const SUSTAINED_SAMPLE_COUNT = 3;

/**
 * GET-only Render control-plane adapter. Render API keys are account-scoped,
 * so the application deliberately calls only service/metric GET endpoints.
 * Only capacity fields needed by the
 * admin console leave this module: service/workspace identifiers, names,
 * repository URLs, dashboard URLs, and the API key are never returned.
 */
class RenderInfrastructureClient {
  /**
   * @param {{
   *   config: {
   *     apiKey: string,
   *     serviceId: string,
   *     monthlyCostUsd?: number|null,
   *   },
   *   fetchImpl?: typeof fetch,
   *   now?: () => Date,
   *   timeoutMs?: number,
   *   cacheTtlMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.config) {
      throw new Error("RenderInfrastructureClient: config required");
    }
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || (() => new Date());
    this.timeoutMs = positiveMs(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.cacheTtlMs = positiveMs(
      deps.cacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
    );
    this._lastGood = null;
    this._freshUntil = 0;
    this._inflight = null;
  }

  async snapshot() {
    const nowMs = this._now().getTime();
    if (this._lastGood && nowMs < this._freshUntil) {
      return { ...this._lastGood, stale: false };
    }
    if (this._inflight) return this._inflight;
    const pending = this._refreshWithFallback();
    this._inflight = pending;
    try {
      return await pending;
    } finally {
      if (this._inflight === pending) this._inflight = null;
    }
  }

  async _refreshWithFallback() {
    try {
      const value = await this._refresh();
      this._lastGood = value;
      this._freshUntil = this._now().getTime() + this.cacheTtlMs;
      return { ...value, stale: false };
    } catch (err) {
      if (this._lastGood) {
        this._freshUntil = 0;
        return { ...this._lastGood, stale: true };
      }
      throw err;
    }
  }

  async _refresh() {
    const end = this._now();
    const start = new Date(end.getTime() - METRIC_WINDOW_MS);
    const queryInput = {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      resolutionSeconds: String(METRIC_RESOLUTION_SECONDS),
      resource: this.config.serviceId,
    };
    // Keep all four metric responses at their native per-instance shape so
    // usage and limit series retain matching labels. utilizationStats() then
    // calculates each ratio and keeps the worst instance for every timestamp.
    const query = new URLSearchParams(queryInput).toString();
    const [service, cpu, cpuLimit, memory, memoryLimit] = await Promise.all([
      this._apiJson(`/services/${encodeURIComponent(this.config.serviceId)}`),
      this._apiJson(`/metrics/cpu?${query}`),
      this._apiJson(`/metrics/cpu-limit?${query}`),
      this._apiJson(`/metrics/memory?${query}`),
      this._apiJson(`/metrics/memory-limit?${query}`),
    ]);
    const details = service?.serviceDetails || {};
    const cpuStats = utilizationStats(cpu, cpuLimit);
    const memoryStats = utilizationStats(memory, memoryLimit);
    return {
      configured: true,
      available: true,
      stale: false,
      measuredAt: latestTimestamp([
        cpuStats.measuredAt,
        memoryStats.measuredAt,
      ]),
      fetchedAt: end.toISOString(),
      service: {
        plan: safeLabel(details.plan),
        configuredInstanceCount: nonNegativeIntegerOrNull(
          details.numInstances,
        ),
        suspended: service?.suspended === "suspended",
        autoscalingEnabled: Boolean(details?.autoscaling?.enabled),
      },
      metrics: {
        available: cpuStats.sampleCount > 0 && memoryStats.sampleCount > 0,
        windowMinutes: Math.round(METRIC_WINDOW_MS / 60_000),
        sustainedWindowMinutes: Math.round(
          SUSTAINED_SAMPLE_COUNT * METRIC_RESOLUTION_SECONDS / 60,
        ),
        resolutionSeconds: METRIC_RESOLUTION_SECONDS,
        measuredAt: latestTimestamp([
          cpuStats.measuredAt,
          memoryStats.measuredAt,
        ]),
        cpu: stripMeasuredAt(cpuStats),
        memory: stripMeasuredAt(memoryStats),
      },
      cost: {
        currency: "USD",
        monthlyPlanningUsd: finiteMoneyOrNull(
          this.config.monthlyCostUsd,
        ),
        estimate: true,
        basis: this.config.monthlyCostUsd == null
          ? "not_configured"
          : "operator_configured",
      },
      errorCode: null,
    };
  }

  /** @param {string} path */
  async _apiJson(path) {
    if (typeof this.fetchImpl !== "function") {
      throw renderError("render_fetch_unavailable");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await this.fetchImpl(`${RENDER_API_URL}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw renderError(`render_admin_http_${response?.status || 0}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  _now() {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error(
        "RenderInfrastructureClient: now() returned invalid date",
      );
    }
    return new Date(value.getTime());
  }
}

/**
 * Render returns one or more time series. The request asks Render to MAX
 * aggregate instances, but flattening keeps the parser safe if the provider
 * still returns multiple series. Usage and limit use the same native unit;
 * only their ratio is exposed.
 *
 * @param {unknown} usageBody
 * @param {unknown} limitBody
 */
function utilizationStats(usageBody, limitBody) {
  const usage = metricPoints(usageBody);
  const limits = metricPoints(limitBody).filter((point) => point.value > 0);
  if (usage.length === 0 || limits.length === 0) {
    return emptyUtilization();
  }
  const fallbackLimit = limits.length === 1 ? limits[0].value : null;
  const limitByKey = new Map(limits.map((point) => [
    `${point.signature}\0${point.timestamp}`,
    point.value,
  ]));
  const latestLimitBySignature = new Map();
  for (const point of limits) {
    latestLimitBySignature.set(point.signature, point.value);
  }
  /** @type {Array<{signature:string,timestamp:string,percent:number}>} */
  const rows = [];
  for (const point of usage) {
    const limit = limitByKey.get(`${point.signature}\0${point.timestamp}`)
      ?? latestLimitBySignature.get(point.signature)
      ?? fallbackLimit;
    if (limit === null || !Number.isFinite(limit) || limit <= 0) continue;
    rows.push({
      signature: point.signature,
      timestamp: point.timestamp,
      percent: clampPercent((point.value / limit) * 100),
    });
  }
  if (rows.length === 0) return emptyUtilization();
  /** @type {Map<string, number>} */
  const worstByTime = new Map();
  for (const row of rows) {
    worstByTime.set(
      row.timestamp,
      Math.max(worstByTime.get(row.timestamp) || 0, row.percent),
    );
  }
  const samples = [...worstByTime.entries()]
    .map(([timestamp, percent]) => ({ timestamp, percent }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const values = samples.map((row) => row.percent);
  return {
    averagePercent: roundPercent(
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ),
    peakPercent: roundPercent(Math.max(...values)),
    latestPercent: roundPercent(samples[samples.length - 1].percent),
    recentAveragePercent: samples.length >= SUSTAINED_SAMPLE_COUNT
      ? roundPercent(
        samples.slice(-SUSTAINED_SAMPLE_COUNT).reduce(
          (sum, row) => sum + row.percent,
          0,
        ) / SUSTAINED_SAMPLE_COUNT,
      )
      : null,
    recentSampleCount: Math.min(samples.length, SUSTAINED_SAMPLE_COUNT),
    sampleCount: samples.length,
    measuredAt: samples[samples.length - 1].timestamp,
  };
}

/**
 * @param {unknown} body
 * @returns {Array<{value:number,timestamp:string,signature:string}>}
 */
function metricPoints(body) {
  const series = Array.isArray(body) ? body : [];
  /** @type {Array<{value:number,timestamp:string,signature:string}>} */
  const points = [];
  for (const row of series) {
    const signature = labelSignature(row?.labels);
    const values = Array.isArray(row?.values) ? row.values : [];
    for (const point of values) {
      if (missingNumericValue(point?.value)) continue;
      const value = Number(point?.value);
      const timestamp = validIso(point?.timestamp);
      if (Number.isFinite(value) && value >= 0 && timestamp) {
        points.push({ value, timestamp, signature });
      }
    }
  }
  return points.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp));
}

/** @param {unknown} labels */
function labelSignature(labels) {
  if (!Array.isArray(labels)) return "";
  return labels
    .map((row) => `${String(row?.field || "")}=${String(row?.value || "")}`)
    .sort()
    .join("|");
}

function emptyUtilization() {
  return {
    averagePercent: null,
    peakPercent: null,
    latestPercent: null,
    recentAveragePercent: null,
    recentSampleCount: 0,
    sampleCount: 0,
    measuredAt: null,
  };
}

/** @param {Record<string, any>} value */
function stripMeasuredAt(value) {
  return {
    averagePercent: value.averagePercent,
    peakPercent: value.peakPercent,
    latestPercent: value.latestPercent,
    recentAveragePercent: value.recentAveragePercent,
    recentSampleCount: value.recentSampleCount,
    sampleCount: value.sampleCount,
  };
}

/** @param {(string|null|undefined)[]} values */
function latestTimestamp(values) {
  /** @type {string[]} */
  const valid = [];
  for (const value of values) {
    const parsed = validIso(value);
    if (parsed) valid.push(parsed);
  }
  valid.sort();
  return valid.length ? valid[valid.length - 1] : null;
}

/** @param {unknown} raw */
function validIso(raw) {
  const text = String(raw || "");
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    const millis = numeric >= 1_000_000_000_000
      ? numeric
      : numeric * 1000;
    const numericDate = new Date(millis);
    return Number.isNaN(numericDate.getTime())
      ? null
      : numericDate.toISOString();
  }
  const value = new Date(text);
  return text && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/** @param {unknown} raw */
function safeLabel(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** @param {unknown} value */
function nonNegativeIntegerOrNull(value) {
  if (missingNumericValue(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** @param {unknown} value */
function missingNumericValue(value) {
  return value === null
    || value === undefined
    || (typeof value === "string" && value.trim() === "");
}

/** @param {unknown} value */
function finiteMoneyOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * 100) / 100
    : null;
}

/** @param {number} value */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** @param {number} value */
function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

/** @param {string} code */
function renderError(code) {
  const err = new Error(code);
  /** @type {any} */ (err).code = code;
  return err;
}

/** @param {number|undefined} value @param {number} fallback */
function positiveMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

module.exports = {
  RenderInfrastructureClient,
  _internals: {
    metricPoints,
    utilizationStats,
  },
};
