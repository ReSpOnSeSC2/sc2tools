"use strict";

/**
 * Public, aggregate-only infrastructure usage snapshot.
 *
 * Cloudflare's Analytics GraphQL API reports bucket storage without an
 * O(number of objects) LIST walk.  The service combines that provider snapshot
 * with the count of completed, server-verified original replay markers in
 * Mongo.  Results are cached and refreshes are single-flight so a public
 * landing-page request can never fan out into repeated provider queries.
 */

const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 15 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const STORAGE_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

// All monetary values are integer mills (1 mill = $0.001).  Integer math
// prevents display drift around Cloudflare's rounded billing units.
const FIXED_MONTHLY_MILLS = 65_190;
const STANDARD_FREE_STORAGE_GB = 10;
const STANDARD_STORAGE_MILLS_PER_GB_MONTH = 15;
const CLASS_A_FREE_REQUESTS = 1_000_000;
const CLASS_A_MILLS_PER_MILLION = 4_500;
const CLASS_B_FREE_REQUESTS = 10_000_000;
const CLASS_B_MILLS_PER_MILLION = 360;
const DECIMAL_GB_BYTES = 1_000_000_000;
const MILLION = 1_000_000;

const CLASS_A_ACTIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

const CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

const FREE_ACTIONS = new Set([
  "DeleteObject",
  "DeleteBucket",
  "AbortMultipartUpload",
]);

const ANALYTICS_QUERY = `
query InfrastructureCosts(
  $accountTag: string!
  $bucketName: string!
  $storageStart: Time!
  $cycleStart: Time!
  $end: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      storage: r2StorageAdaptiveGroups(
        limit: 1
        filter: {
          bucketName: $bucketName
          datetime_geq: $storageStart
          datetime_leq: $end
        }
        orderBy: [datetime_DESC]
      ) {
        max {
          objectCount
          uploadCount
          payloadSize
          metadataSize
        }
        dimensions {
          datetime
        }
      }
      operations: r2OperationsAdaptiveGroups(
        limit: 10000
        filter: {
          bucketName: $bucketName
          datetime_geq: $cycleStart
          datetime_leq: $end
        }
      ) {
        sum {
          requests
        }
        dimensions {
          actionType
        }
      }
    }
  }
}`;

class InfrastructureUsageService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   cloudflareAnalytics?: {
   *     accountId: string,
   *     apiToken: string,
   *     bucket: string,
   *     billingCycleDay?: number,
   *   } | null,
   *   fetchImpl?: typeof fetch,
   *   now?: () => Date,
   *   cacheTtlMs?: number,
   *   errorRetryMs?: number,
   *   timeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.games) {
      throw new Error("InfrastructureUsageService: games required");
    }
    this.games = deps.games;
    this.config = deps.cloudflareAnalytics || null;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || (() => new Date());
    this.cacheTtlMs = positiveMs(deps.cacheTtlMs, CACHE_TTL_MS);
    this.errorRetryMs = positiveMs(deps.errorRetryMs, ERROR_RETRY_MS);
    this.timeoutMs = positiveMs(deps.timeoutMs, REQUEST_TIMEOUT_MS);

    /** @type {Record<string, any> | null} */
    this._lastGood = null;
    this._freshUntil = 0;
    this._retryAfter = 0;
    /** @type {Promise<Record<string, any>> | null} */
    this._inflight = null;
  }

  /**
   * Return a fresh cached snapshot, refresh once, or serve the last-good
   * snapshot marked stale when Cloudflare/Mongo is temporarily unavailable.
   */
  async snapshot() {
    const nowMs = this._now().getTime();
    if (this._lastGood && nowMs < this._freshUntil) {
      return publicSnapshot(this._lastGood, false);
    }
    if (this._lastGood && nowMs < this._retryAfter) {
      return publicSnapshot(this._lastGood, true);
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
    if (!this.config) throw unavailableError();
    try {
      const snapshot = await this._refresh();
      const nowMs = this._now().getTime();
      this._lastGood = snapshot;
      this._freshUntil = nowMs + this.cacheTtlMs;
      this._retryAfter = 0;
      return publicSnapshot(snapshot, false);
    } catch (err) {
      if (!this._lastGood) throw unavailableError(err);
      this._freshUntil = 0;
      this._retryAfter = this._now().getTime() + this.errorRetryMs;
      return publicSnapshot(this._lastGood, true);
    }
  }

  async _refresh() {
    const config = this.config;
    if (!config) throw unavailableError();
    const now = this._now();
    const cycleStart = billingCycleStart(now, config.billingCycleDay || 1);
    const storageStart = new Date(now.getTime() - STORAGE_LOOKBACK_MS);

    const [analytics, archivedOriginalReplayCount] = await Promise.all([
      this._fetchAnalytics({ now, cycleStart, storageStart }),
      this._countArchivedOriginalReplays(),
    ]);
    const operations = classifyOperations(analytics.operationRows);
    const costs = calculateCosts({
      payloadBytes: analytics.storage.payloadBytes,
      classARequests: operations.classARequests,
      classBRequests: operations.classBRequests,
    });

    return {
      archivedOriginalReplayCount,
      r2: {
        payloadBytes: analytics.storage.payloadBytes,
        metadataBytes: analytics.storage.metadataBytes,
        objectCount: analytics.storage.objectCount,
        pendingMultipartUploadCount:
          analytics.storage.pendingMultipartUploadCount,
      },
      operations: {
        cycleStart: cycleStart.toISOString(),
        through: now.toISOString(),
        classARequests: operations.classARequests,
        classBRequests: operations.classBRequests,
        freeRequests: operations.freeRequests,
        unknownRequests: operations.unknownRequests,
      },
      costs,
      providerAsOf: analytics.storage.asOf,
      computedAt: now.toISOString(),
    };
  }

  async _countArchivedOriginalReplays() {
    const count = await this.games.countDocuments(
      { "replayFile.storedAt": { $exists: true } },
      { maxTimeMS: this.timeoutMs },
    );
    return nonNegativeSafeInteger(count, "archived replay count");
  }

  /**
   * @param {{now: Date, cycleStart: Date, storageStart: Date}} range
   */
  async _fetchAnalytics(range) {
    const config = this.config;
    if (!config) throw unavailableError();
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch unavailable");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    let body;
    try {
      const response = await this.fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: ANALYTICS_QUERY,
          variables: {
            accountTag: config.accountId,
            bucketName: config.bucket,
            storageStart: range.storageStart.toISOString(),
            cycleStart: range.cycleStart.toISOString(),
            end: range.now.toISOString(),
          },
        }),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw new Error(`cloudflare analytics http ${response?.status || 0}`);
      }
      body = await response.json();
    } finally {
      clearTimeout(timer);
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new Error("cloudflare analytics graphql error");
    }
    return parseAnalyticsBody(body);
  }

  _now() {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("InfrastructureUsageService: now() returned invalid date");
    }
    return new Date(value.getTime());
  }
}

/** @param {any} body */
function parseAnalyticsBody(body) {
  const accounts = body?.data?.viewer?.accounts;
  const account = Array.isArray(accounts) ? accounts[0] : null;
  const storageRows = account?.storage;
  if (!Array.isArray(storageRows) || storageRows.length === 0) {
    throw new Error("cloudflare analytics storage snapshot missing");
  }
  const row = storageRows[0];
  const max = row?.max || {};
  const asOf = String(row?.dimensions?.datetime || "");
  if (!asOf || Number.isNaN(new Date(asOf).getTime())) {
    throw new Error("cloudflare analytics storage timestamp missing");
  }
  return {
    storage: {
      payloadBytes: nonNegativeSafeInteger(max.payloadSize, "payloadSize"),
      metadataBytes: nonNegativeSafeInteger(max.metadataSize, "metadataSize"),
      objectCount: nonNegativeSafeInteger(max.objectCount, "objectCount"),
      pendingMultipartUploadCount: nonNegativeSafeInteger(
        max.uploadCount,
        "uploadCount",
      ),
      asOf: new Date(asOf).toISOString(),
    },
    operationRows: Array.isArray(account.operations) ? account.operations : [],
  };
}

/** @param {any[]} rows */
function classifyOperations(rows) {
  const totals = {
    classARequests: 0,
    classBRequests: 0,
    freeRequests: 0,
    unknownRequests: 0,
  };
  for (const row of rows) {
    const action = String(row?.dimensions?.actionType || "");
    const requests = nonNegativeSafeInteger(row?.sum?.requests, "requests");
    if (CLASS_A_ACTIONS.has(action)) totals.classARequests += requests;
    else if (CLASS_B_ACTIONS.has(action)) totals.classBRequests += requests;
    else if (FREE_ACTIONS.has(action)) totals.freeRequests += requests;
    else totals.unknownRequests += requests;
  }
  for (const [key, value] of Object.entries(totals)) {
    if (!Number.isSafeInteger(value)) throw new Error(`${key} exceeds safe integer`);
  }
  return totals;
}

/**
 * @param {{payloadBytes: number, classARequests: number, classBRequests: number}} usage
 */
function calculateCosts(usage) {
  const payloadBytes = nonNegativeSafeInteger(usage.payloadBytes, "payloadBytes");
  const classARequests = nonNegativeSafeInteger(
    usage.classARequests,
    "classARequests",
  );
  const classBRequests = nonNegativeSafeInteger(
    usage.classBRequests,
    "classBRequests",
  );

  // Cloudflare bills decimal GB-months and rounds usage up to the next GB.
  const roundedStorageGb = Math.ceil(payloadBytes / DECIMAL_GB_BYTES);
  const billableStorageGb = Math.max(
    0,
    roundedStorageGb - STANDARD_FREE_STORAGE_GB,
  );
  const storageMonthlyMills =
    billableStorageGb * STANDARD_STORAGE_MILLS_PER_GB_MONTH;
  const classAMonthlyMills = roundedMillionCost(
    classARequests,
    CLASS_A_FREE_REQUESTS,
    CLASS_A_MILLS_PER_MILLION,
  );
  const classBMonthlyMills = roundedMillionCost(
    classBRequests,
    CLASS_B_FREE_REQUESTS,
    CLASS_B_MILLS_PER_MILLION,
  );
  const r2EstimatedMonthlyMills =
    storageMonthlyMills + classAMonthlyMills + classBMonthlyMills;
  return {
    currency: "USD",
    unit: "mills",
    fixedMonthlyMills: FIXED_MONTHLY_MILLS,
    storageMonthlyMills,
    classAMonthlyMills,
    classBMonthlyMills,
    r2EstimatedMonthlyMills,
    estimatedTotalMonthlyMills:
      FIXED_MONTHLY_MILLS + r2EstimatedMonthlyMills,
  };
}

/**
 * @param {number} requests
 * @param {number} freeRequests
 * @param {number} millsPerMillion
 */
function roundedMillionCost(requests, freeRequests, millsPerMillion) {
  const billable = Math.max(0, requests - freeRequests);
  return Math.ceil(billable / MILLION) * millsPerMillion;
}

/** @param {Date} now @param {number} day */
function billingCycleStart(now, day) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(year, month, day));
  if (now.getTime() >= thisMonth.getTime()) return thisMonth;
  return new Date(Date.UTC(year, month - 1, day));
}

/** @param {Record<string, any>} value @param {boolean} stale */
function publicSnapshot(value, stale) {
  // Explicit reconstruction is a response allowlist.  Provider credentials,
  // account IDs, bucket names, and raw action names cannot leak even if the
  // internal refresh representation grows later.
  return {
    asOf: value.providerAsOf,
    stale: Boolean(stale),
    estimate: true,
    archive: {
      verifiedOriginalReplays: value.archivedOriginalReplayCount,
      r2StoredBytes: value.r2.payloadBytes,
      r2ObjectCount: value.r2.objectCount,
      includes: "originals_and_analysis",
    },
    r2: {
      cycleStart: value.operations.cycleStart,
      classARequests: value.operations.classARequests,
      classBRequests: value.operations.classBRequests,
      unknownRequests: value.operations.unknownRequests,
      estimatedCostUsd: {
        storageRunRate: millsToUsd(value.costs.storageMonthlyMills),
        classAThisCycle: millsToUsd(value.costs.classAMonthlyMills),
        classBThisCycle: millsToUsd(value.costs.classBMonthlyMills),
        currentMonthly: millsToUsd(value.costs.r2EstimatedMonthlyMills),
      },
    },
    site: {
      fixedMonthlyEquivalentUsd: millsToUsd(value.costs.fixedMonthlyMills),
      estimatedCurrentMonthlyTotalUsd: millsToUsd(
        value.costs.estimatedTotalMonthlyMills,
      ),
    },
  };
}

/** @param {number} mills */
function millsToUsd(mills) {
  return nonNegativeSafeInteger(mills, "cost mills") / 1000;
}

/** @param {unknown} [cause] */
function unavailableError(cause) {
  const err = new Error("infrastructure_costs_unavailable");
  /** @type {any} */ (err).code = "infrastructure_costs_unavailable";
  /** @type {any} */ (err).status = 503;
  if (cause) /** @type {any} */ (err).cause = cause;
  return err;
}

/** @param {unknown} value @param {string} label */
function nonNegativeSafeInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`invalid cloudflare ${label}`);
  }
  return number;
}

/** @param {number|undefined} value @param {number} fallback */
function positiveMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

module.exports = {
  InfrastructureUsageService,
  _internals: {
    ANALYTICS_QUERY,
    CLASS_A_ACTIONS,
    CLASS_B_ACTIONS,
    FREE_ACTIONS,
    billingCycleStart,
    calculateCosts,
    classifyOperations,
    parseAnalyticsBody,
  },
};
