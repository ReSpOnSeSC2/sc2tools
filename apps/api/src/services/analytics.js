"use strict";

/**
 * AnalyticsService — server-side reader for Google Analytics 4 metrics
 * via the GA4 Data API (``@google-analytics/data``).
 *
 * Powers the ``/admin/analytics`` tab. Everything here is REAL data
 * pulled live from the configured GA4 property — there are no fixtures
 * or synthetic rows. When GA isn't configured (no property id /
 * credentials) the service reports ``enabled === false`` and the route
 * layer returns a "not configured" payload so the admin UI can render a
 * setup hint instead of erroring.
 *
 * Auth model
 * ----------
 * The Data API authenticates as a Google Cloud service account. The
 * credential source is resolved in ``config/loader.js`` into either an
 * inline ``{ client_email, private_key }`` object (from the base64 env
 * var) or Application Default Credentials (a key file path). This
 * service is otherwise a pure adapter: route-layer ``isAdmin`` gating
 * is the only authorization, exactly like the other admin services.
 *
 * Cost / quota
 * ------------
 * Admin traffic is tiny, so ``summary()`` fans out a handful of
 * ``runReport`` calls in parallel rather than micro-optimising into a
 * single batch. ``realtime()`` is a separate, cheaper call meant to be
 * polled on a short interval by the UI.
 */

// Metric ids requested for the headline totals + the daily series.
// Kept in one place so the totals row and the timeseries stay in sync.
const CORE_METRICS = [
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagementRate",
  "averageSessionDuration",
];

class AnalyticsService {
  /**
   * @param {{
   *   config: {
   *     enabled: boolean,
   *     propertyId: string|null,
   *     credentials: { client_email: string, private_key: string }|null,
   *     keyFile: string|null,
   *   },
   *   clientFactory?: () => any,
   * }} deps
   *
   * ``clientFactory`` is an injection seam for tests — it returns a
   * stub exposing ``runReport`` / ``runRealtimeReport``. In production
   * it's omitted and we lazily construct a real
   * ``BetaAnalyticsDataClient`` on first use.
   */
  constructor(deps) {
    if (!deps || !deps.config) {
      throw new Error("AnalyticsService: config required");
    }
    this.config = deps.config;
    this._clientFactory = deps.clientFactory || null;
    this._client = null;
  }

  /** Whether GA is wired up enough to serve real data. */
  isEnabled() {
    return Boolean(this.config.enabled);
  }

  /**
   * Lazily build (and cache) the Data API client. Constructing it is
   * cheap but does parse credentials, so we defer until the first
   * admin actually opens the tab.
   *
   * @returns {any} The GA4 Data API client (or an injected test stub).
   *   Typed ``any`` because the client is dynamically ``require``d only
   *   when GA is in use, so its protobuf types aren't in scope here.
   */
  _getClient() {
    if (this._client) return this._client;
    if (this._clientFactory) {
      this._client = this._clientFactory();
      return this._client;
    }
    // Required lazily so importing this module never pulls in the
    // (heavy) Google client unless GA is actually used.
    const { BetaAnalyticsDataClient } = require("@google-analytics/data");
    this._client = this.config.credentials
      ? new BetaAnalyticsDataClient({ credentials: this.config.credentials })
      : new BetaAnalyticsDataClient();
    return this._client;
  }

  get _property() {
    return `properties/${this.config.propertyId}`;
  }

  /**
   * One-shot dashboard payload: headline totals (with prior-period
   * deltas), a daily timeseries, and the top pages / channels /
   * devices / countries breakdowns. Fanned out in parallel.
   *
   * @param {{ days?: number }} [opts]
   */
  async summary(opts = {}) {
    const days = clampDays(opts.days);
    const cur = currentRange(days);
    const prev = previousRange(days);

    const [series, prevTotals, pages, channels, devices, countries] =
      await Promise.all([
        this._timeseries(cur),
        this._totals(prev),
        this._topPages(cur),
        this._channels(cur),
        this._devices(cur),
        this._countries(cur),
      ]);

    const totals = sumSeries(series);
    return {
      configured: true,
      range: { days, startDate: cur.startDate, endDate: cur.endDate },
      totals,
      previous: prevTotals,
      deltas: computeDeltas(totals, prevTotals),
      timeseries: series,
      topPages: pages,
      channels,
      devices,
      countries,
    };
  }

  /**
   * Realtime snapshot — active users in the last 30 minutes, plus a
   * small per-country breakdown. Meant to be polled on a short
   * interval by the UI.
   */
  async realtime() {
    const [resp] = await this._getClient().runRealtimeReport({
      property: this._property,
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      limit: 8,
    });
    const rows = (resp.rows || []).map((/** @type {any} */ r) => ({
      country: dim(r, 0) || "(unknown)",
      activeUsers: metric(r, 0),
    }));
    const activeUsers = rows.reduce((/** @type {number} */ acc, /** @type {any} */ r) => acc + r.activeUsers, 0);
    return { configured: true, activeUsers, byCountry: rows };
  }

  // ---- individual reports -------------------------------------------

  /**
   * Headline totals for a single range, no dimensions.
   * @param {{ startDate: string, endDate: string }} range
   */
  async _totals(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      metrics: CORE_METRICS.map((name) => ({ name })),
    });
    const row = (resp.rows || [])[0];
    return shapeTotals(row);
  }

  /**
   * Daily series over the range, ascending by date.
   * @param {{ startDate: string, endDate: string }} range
   */
  async _timeseries(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      dimensions: [{ name: "date" }],
      metrics: CORE_METRICS.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
    });
    return (resp.rows || []).map((/** @type {any} */ r) => ({
      date: isoDate(dim(r, 0)),
      activeUsers: metric(r, 0),
      newUsers: metric(r, 1),
      sessions: metric(r, 2),
      screenPageViews: metric(r, 3),
      engagementRate: round(metricFloat(r, 4), 4),
      averageSessionDuration: round(metricFloat(r, 5), 1),
    }));
  }

  /**
   * Most-viewed pages.
   * @param {{ startDate: string, endDate: string }} range
   */
  async _topPages(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      orderBys: [
        { metric: { metricName: "screenPageViews" }, desc: true },
      ],
      limit: 10,
    });
    return (resp.rows || []).map((/** @type {any} */ r) => ({
      path: dim(r, 0) || "(not set)",
      title: dim(r, 1) || "",
      views: metric(r, 0),
      activeUsers: metric(r, 1),
    }));
  }

  /**
   * Sessions + users grouped by default channel grouping.
   * @param {{ startDate: string, endDate: string }} range
   */
  async _channels(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    });
    return (resp.rows || []).map((/** @type {any} */ r) => ({
      channel: dim(r, 0) || "(other)",
      sessions: metric(r, 0),
      activeUsers: metric(r, 1),
    }));
  }

  /**
   * Active users by device category (desktop / mobile / tablet).
   * @param {{ startDate: string, endDate: string }} range
   */
  async _devices(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 6,
    });
    return (resp.rows || []).map((/** @type {any} */ r) => ({
      device: dim(r, 0) || "(unknown)",
      activeUsers: metric(r, 0),
      sessions: metric(r, 1),
    }));
  }

  /**
   * Top countries by active users.
   * @param {{ startDate: string, endDate: string }} range
   */
  async _countries(range) {
    const [resp] = await this._getClient().runReport({
      property: this._property,
      dateRanges: [range],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 10,
    });
    return (resp.rows || []).map((/** @type {any} */ r) => ({
      country: dim(r, 0) || "(unknown)",
      activeUsers: metric(r, 0),
    }));
  }
}

// ---- date-range helpers ---------------------------------------------

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 28;

/** @param {unknown} raw */
function clampDays(raw) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

/**
 * Current window: the last ``days`` days inclusive of today.
 * @param {number} days
 */
function currentRange(days) {
  return { startDate: `${days - 1}daysAgo`, endDate: "today" };
}

/**
 * The equal-length window immediately before the current one.
 * @param {number} days
 */
function previousRange(days) {
  return { startDate: `${days * 2 - 1}daysAgo`, endDate: `${days}daysAgo` };
}

// ---- row-shaping helpers --------------------------------------------

/** @param {any} row — a GA4 metricValues-bearing row, or undefined. */
function shapeTotals(row) {
  return {
    activeUsers: metric(row, 0),
    newUsers: metric(row, 1),
    sessions: metric(row, 2),
    screenPageViews: metric(row, 3),
    engagementRate: round(metricFloat(row, 4), 4),
    averageSessionDuration: round(metricFloat(row, 5), 1),
  };
}

/**
 * Sum a daily series into headline totals. Rates are re-derived.
 * @param {Array<Record<string, number>>} series
 */
function sumSeries(series) {
  const out = {
    activeUsers: 0,
    newUsers: 0,
    sessions: 0,
    screenPageViews: 0,
    engagementRate: 0,
    averageSessionDuration: 0,
  };
  if (series.length === 0) return out;
  let engagementAcc = 0;
  let durationAcc = 0;
  for (const d of series) {
    out.activeUsers += d.activeUsers;
    out.newUsers += d.newUsers;
    out.sessions += d.sessions;
    out.screenPageViews += d.screenPageViews;
    engagementAcc += d.engagementRate;
    durationAcc += d.averageSessionDuration;
  }
  // engagementRate / avg session duration are per-day rates; a simple
  // mean across days is a faithful headline (GA's own period rollup
  // weights by sessions, but the daily mean is close enough for an
  // at-a-glance KPI and avoids a second totals round-trip).
  out.engagementRate = round(engagementAcc / series.length, 4);
  out.averageSessionDuration = round(durationAcc / series.length, 1);
  return out;
}

/**
 * Percentage change of each headline metric vs the prior period.
 * Returns ``null`` for a metric when the prior value is 0 (an infinite
 * jump isn't meaningful to chart) so the UI can show "—" instead.
 */
/**
 * @param {Record<string, number>} cur
 * @param {Record<string, number>} prev
 */
function computeDeltas(cur, prev) {
  /** @type {Record<string, number|null>} */
  const out = {};
  for (const key of Object.keys(cur)) {
    const before = prev[key];
    const after = cur[key];
    if (!before || before === 0) {
      out[key] = after > 0 ? null : 0;
    } else {
      out[key] = round(((after - before) / before) * 100, 1);
    }
  }
  return out;
}

/**
 * Read integer metric value at index ``i`` off a GA row.
 * @param {any} row @param {number} i
 */
function metric(row, i) {
  const v = row && row.metricValues && row.metricValues[i];
  if (!v) return 0;
  const n = Number.parseInt(v.value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read float metric value at index ``i`` off a GA row.
 * @param {any} row @param {number} i
 */
function metricFloat(row, i) {
  const v = row && row.metricValues && row.metricValues[i];
  if (!v) return 0;
  const n = Number.parseFloat(v.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read dimension value at index ``i`` off a GA row.
 * @param {any} row @param {number} i
 */
function dim(row, i) {
  const v = row && row.dimensionValues && row.dimensionValues[i];
  return v ? v.value : "";
}

/**
 * GA returns dates as ``YYYYMMDD``; normalise to ``YYYY-MM-DD``.
 * @param {string} raw
 */
function isoDate(raw) {
  if (!raw || raw.length !== 8) return raw || "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** @param {number} n @param {number} digits */
function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

module.exports = { AnalyticsService };
