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

const {
  AtlasInfrastructureClient,
} = require("./atlasInfrastructure");
const {
  RenderInfrastructureClient,
} = require("./renderInfrastructure");
const {
  buildInfrastructureAdminSnapshot,
} = require("./infrastructureAdvisories");

const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 15 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const STORAGE_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

// All monetary values are integer mills (1 mill = $0.001).  Integer math
// prevents display drift around Cloudflare's rounded billing units.
const FIXED_MONTHLY_MILLS = 65_190;
const MONGO_MONTHLY_PLANNING_MILLS = 56_940;
const NON_MONGO_FIXED_MONTHLY_MILLS =
  FIXED_MONTHLY_MILLS - MONGO_MONTHLY_PLANNING_MILLS;
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
  // Cloudflare prices object listings as ListObjects, while its
  // S3-compatible API can report the concrete v1/v2 operation name.
  "ListObjectsV1",
  "ListObjectsV2",
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
  // DeleteObjects is the S3 bulk form of the same free delete operation.
  "DeleteObjects",
  "DeleteBucket",
  "AbortMultipartUpload",
  // Cloudflare's bucket dashboard emits these control-plane configuration
  // reads. They are absent from the documented Class A/B billing lists and
  // are not replay-storage traffic.
  "GetBucketNotificationConfiguration",
  "GetBucketSippyConfiguration",
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
   *   mongoDb: import('mongodb').Db,
   *   cloudflareAnalytics?: {
   *     accountId: string,
   *     apiToken: string,
   *     bucket: string,
   *     billingCycleDay?: number,
   *   } | null,
   *   atlasAdmin?: {
   *     clientId: string,
   *     clientSecret: string,
   *     orgId: string,
   *     projectId: string,
   *     clusterName: string,
   *     secretExpiresAt?: string|null,
   *   } | null,
   *   atlasClient?: { snapshot: () => Promise<Record<string, any>> } | null,
   *   renderAdmin?: {
   *     apiKey: string,
   *     serviceId: string,
   *     monthlyCostUsd?: number|null,
   *   } | null,
   *   renderClient?: { snapshot: () => Promise<Record<string, any>> } | null,
   *   fetchImpl?: typeof fetch,
   *   now?: () => Date,
   *   cacheTtlMs?: number,
   *   errorRetryMs?: number,
   *   timeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.games || !deps.mongoDb) {
      throw new Error("InfrastructureUsageService: games and mongoDb required");
    }
    this.games = deps.games;
    this.mongoDb = deps.mongoDb;
    this.config = deps.cloudflareAnalytics || null;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || (() => new Date());
    this.cacheTtlMs = positiveMs(deps.cacheTtlMs, CACHE_TTL_MS);
    this.errorRetryMs = positiveMs(deps.errorRetryMs, ERROR_RETRY_MS);
    this.timeoutMs = positiveMs(deps.timeoutMs, REQUEST_TIMEOUT_MS);
    this.atlasSecretExpiresAt = deps.atlasAdmin?.secretExpiresAt || null;
    this.atlas = deps.atlasClient === undefined
      ? (deps.atlasAdmin
        ? new AtlasInfrastructureClient({
          config: deps.atlasAdmin,
          fetchImpl: this.fetchImpl,
          now: this.now,
          timeoutMs: this.timeoutMs,
        })
        : null)
      : deps.atlasClient;
    this.render = deps.renderClient === undefined
      ? (deps.renderAdmin
        ? new RenderInfrastructureClient({
          config: deps.renderAdmin,
          fetchImpl: this.fetchImpl,
          now: this.now,
          timeoutMs: this.timeoutMs,
        })
        : null)
      : deps.renderClient;

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

  /**
   * Whole-database dbStats, Atlas capacity/billing diagnostics, and the
   * repository's planning allowance. Atlas failures degrade inside the
   * returned provider status, so dbStats remains available independently.
   */
  async mongoStorageSnapshot() {
    const [appData, atlas] = await Promise.all([
      this._readMongoStorage(),
      this._readAtlas(),
    ]);
    return this._adminMongoStatus({
      appData,
      atlas,
      pricing: mongoPlanningPrice(),
    });
  }

  /**
   * Credential-free diagnostics for the admin Health surface. Provider error
   * messages are reduced to stable codes so a failed upstream request cannot
   * reflect tokens, identifiers, hostnames, or cluster names.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async adminStatus() {
    /** @type {Record<string, any>|null} */
    let status = null;
    if (this.config) {
      try {
        const snapshot = await this.snapshot();
        status = {
          cloudflareAnalytics: {
            configured: true,
            available: true,
            stale: snapshot.stale,
            asOf: snapshot.asOf,
            errorCode: snapshot.stale ? "stale_last_good" : null,
          },
          mongo: this._adminMongoStatus(
            this._lastGood?.mongo,
            snapshot.stale,
          ),
        };
      } catch {
        // Fall through to independent Mongo/Atlas probes. This preserves
        // useful diagnostics when Cloudflare is the only failing provider.
      }
    }
    if (!status) {
      const [mongoResult, atlasResult] = await Promise.allSettled([
        this._readMongoStorage(),
        this._readAtlas(),
      ]);
      status = {
        cloudflareAnalytics: {
          configured: Boolean(this.config),
          available: false,
          stale: false,
          asOf: null,
          errorCode: this.config
            ? "analytics_unavailable"
            : "not_configured",
        },
        mongo: this._adminMongoStatus({
          appData: mongoResult.status === "fulfilled"
            ? mongoResult.value
            : null,
          atlas: atlasResult.status === "fulfilled"
            ? atlasResult.value
            : unavailableAtlas("atlas_admin_unavailable"),
          pricing: mongoPlanningPrice(),
        }),
      };
    }
    status.render = await this._readRender();
    return status;
  }

  /**
   * Authenticated-admin infrastructure contract. Cloudflare may be absent or
   * temporarily unavailable without hiding Mongo/Render diagnostics.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async adminSnapshot() {
    const [statusResult, costResult] = await Promise.allSettled([
      this.adminStatus(),
      this.config ? this.snapshot() : Promise.resolve(null),
    ]);
    /** @type {Record<string, any>} */
    const status = statusResult.status === "fulfilled"
      ? statusResult.value
      : {
        cloudflareAnalytics: {
          configured: Boolean(this.config),
          available: false,
          stale: false,
          asOf: null,
          errorCode: "analytics_unavailable",
        },
        mongo: this._adminMongoStatus(null),
        render: unavailableRender(
          this.render ? "render_admin_unavailable" : "not_configured",
        ),
      };
    return buildInfrastructureAdminSnapshot({
      asOf: this._now().toISOString(),
      cloudflare: {
        status: status.cloudflareAnalytics,
        snapshot: costResult.status === "fulfilled"
          ? costResult.value
          : null,
      },
      mongo: status.mongo,
      render: status.render,
    });
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

    const [
      analytics,
      archivedOriginalReplayCount,
      mongoAppData,
      atlas,
    ] = await Promise.all([
      this._fetchAnalytics({ now, cycleStart, storageStart }),
      this._countArchivedOriginalReplays(),
      this._readMongoStorage(now),
      this._readAtlas(),
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
      mongo: {
        appData: mongoAppData,
        atlas,
        pricing: mongoPlanningPrice(),
      },
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

  /** @param {Date} [measuredAt] */
  async _readMongoStorage(measuredAt = this._now()) {
    const stats = await this.mongoDb.command({
      dbStats: 1,
      scale: 1,
      maxTimeMS: this.timeoutMs,
    });
    const allocatedDocumentBytes = nonNegativeSafeInteger(
      stats?.storageSize,
      "Mongo storageSize",
    );
    const allocatedIndexBytes = nonNegativeSafeInteger(
      stats?.indexSize,
      "Mongo indexSize",
    );
    const allocatedTotalBytes = allocatedDocumentBytes + allocatedIndexBytes;
    if (!Number.isSafeInteger(allocatedTotalBytes)) {
      throw new Error("Mongo allocated total exceeds safe integer");
    }
    return {
      logicalDataBytes: nonNegativeSafeInteger(
        stats?.dataSize,
        "Mongo dataSize",
      ),
      allocatedDocumentBytes,
      allocatedIndexBytes,
      allocatedTotalBytes,
      scope: "sc2tools_database_only",
      measuredAt: measuredAt.toISOString(),
    };
  }

  async _readAtlas() {
    if (!this.atlas) return unavailableAtlas("not_configured");
    try {
      const value = await this.atlas.snapshot();
      return adminAtlasStatus(value);
    } catch {
      return unavailableAtlas("atlas_admin_unavailable");
    }
  }

  async _readRender() {
    if (!this.render) return unavailableRender("not_configured");
    try {
      return await this.render.snapshot();
    } catch {
      return unavailableRender("render_admin_unavailable");
    }
  }

  /**
   * @param {Record<string, any> | null | undefined} mongo
   * @param {boolean} [stale]
   */
  _adminMongoStatus(mongo, stale = false) {
    const status = adminMongoStatus(mongo, stale);
    /** @type {any} */ (status.atlas).credential = atlasCredentialHealth(
      this.atlasSecretExpiresAt,
      this._now(),
    );
    return status;
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
  const mongo = publicMongoSnapshot(value.mongo);
  const projectedAtlasCents = mongo.atlas.billing?.available
    ? mongo.atlas.billing.projectedMonthlyRunRateCents
    : null;
  const hasAtlasProjection = Number.isSafeInteger(projectedAtlasCents)
    && projectedAtlasCents >= 0;
  const atlasMonthlyMills = hasAtlasProjection
    ? nonNegativeSafeInteger(
      projectedAtlasCents * 10,
      "Atlas projected monthly mills",
    )
    : MONGO_MONTHLY_PLANNING_MILLS;
  const estimatedCurrentMonthlyMills = nonNegativeSafeInteger(
    (hasAtlasProjection
      ? NON_MONGO_FIXED_MONTHLY_MILLS + atlasMonthlyMills
      : FIXED_MONTHLY_MILLS)
      + value.costs.r2EstimatedMonthlyMills,
    "site estimated current monthly mills",
  );

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
    mongo,
    site: {
      // Retained during the rollout so the already-deployed web build can
      // consume the expanded response until its replacement is live.
      fixedMonthlyEquivalentUsd: millsToUsd(value.costs.fixedMonthlyMills),
      nonMongoFixedMonthlyUsd: millsToUsd(NON_MONGO_FIXED_MONTHLY_MILLS),
      pricingMode: hasAtlasProjection
        ? "atlas_projected"
        : "planning_fallback",
      estimatedCurrentMonthlyTotalUsd: millsToUsd(
        estimatedCurrentMonthlyMills,
      ),
    },
  };
}

/**
 * Public Mongo allowlist. Application bytes, disk capacity, and aggregate
 * charges are intentionally public because they power the site's transparent
 * cost explanation. Provider/region, org/project/cluster identifiers,
 * hostnames, credential health, SKUs, and raw line items stay admin-only.
 *
 * @param {Record<string, any>} value
 */
function publicMongoSnapshot(value) {
  const app = value?.appData || {};
  const atlas = value?.atlas || {};
  const cluster = atlas.available && atlas.cluster
    ? {
      tier: atlas.cluster.tier ?? null,
      provisionedDiskGb: atlas.cluster.provisionedDiskGb ?? null,
      diskUsedBytes: atlas.cluster.diskUsedBytes ?? null,
      diskCapacityBytes: atlas.cluster.diskCapacityBytes ?? null,
      diskMeasuredAt: atlas.cluster.diskMeasuredAt ?? null,
      autoExpandStorage: Boolean(atlas.cluster.autoExpandStorage),
    }
    : null;
  const sourceBilling = atlas.available ? atlas.billing : null;
  const sourceCategories = sourceBilling?.categoryCents;
  const billing = sourceBilling
    ? {
      available: Boolean(sourceBilling.available),
      cycleStart: sourceBilling.cycleStart ?? null,
      cycleEnd: sourceBilling.cycleEnd ?? null,
      postedThrough: sourceBilling.postedThrough ?? null,
      postedCycleCents: sourceBilling.postedCycleCents ?? null,
      categoryCents: sourceCategories
        ? {
          compute: sourceCategories.compute,
          storage: sourceCategories.storage,
          transfer: sourceCategories.transfer,
          other: sourceCategories.other,
        }
        : null,
      projectedMonthlyRunRateCents:
        sourceBilling.projectedMonthlyRunRateCents ?? null,
      projectedMonthlyRunRateUsd:
        sourceBilling.projectedMonthlyRunRateUsd ?? null,
    }
    : null;

  return {
    appData: {
      logicalDataBytes: app.logicalDataBytes,
      allocatedDocumentBytes: app.allocatedDocumentBytes,
      allocatedIndexBytes: app.allocatedIndexBytes,
      allocatedTotalBytes: app.allocatedTotalBytes,
      measuredAt: app.measuredAt,
      scope: "sc2tools_database_only",
    },
    atlas: {
      available: Boolean(atlas.available),
      cluster,
      billing,
    },
    planning: {
      monthlyUsd: millsToUsd(MONGO_MONTHLY_PLANNING_MILLS),
    },
  };
}

function mongoPlanningPrice() {
  return {
    monthlyPlanningEstimateUsd: millsToUsd(MONGO_MONTHLY_PLANNING_MILLS),
    includedInSiteFixedMonthlyEquivalent: true,
    estimate: true,
    basis: "repo_budget_assumption",
  };
}

/**
 * @param {Record<string, any> | null | undefined} mongo
 * @param {boolean} [stale]
 */
function adminMongoStatus(mongo, stale = false) {
  if (!mongo) {
    return {
      appData: null,
      atlas: unavailableAtlas("atlas_admin_unavailable"),
      pricing: mongoPlanningPrice(),
    };
  }
  return {
    ...(stale ? { stale: true } : {}),
    appData: mongo.appData,
    atlas: adminAtlasStatus(mongo.atlas),
    pricing: mongoPlanningPrice(),
  };
}

/** @param {Record<string, any>} value */
function adminAtlasStatus(value) {
  if (!value || !value.available) {
    return unavailableAtlas(value?.errorCode || "atlas_admin_unavailable");
  }
  return {
    configured: true,
    available: true,
    measuredAt: value.measuredAt ?? null,
    cluster: value.cluster || null,
    billing: value.billing || null,
    errorCode: value.configErrorCode ?? null,
  };
}

/** @param {string} errorCode */
function unavailableAtlas(errorCode) {
  return {
    configured: errorCode !== "not_configured",
    available: false,
    measuredAt: null,
    cluster: null,
    billing: null,
    errorCode,
  };
}

/** @param {string} errorCode */
function unavailableRender(errorCode) {
  return {
    configured: errorCode !== "not_configured",
    available: false,
    stale: false,
    measuredAt: null,
    fetchedAt: null,
    service: null,
    metrics: null,
    cost: null,
    errorCode,
  };
}

/** @param {string|null} expiresAt @param {Date} now */
function atlasCredentialHealth(expiresAt, now) {
  if (!expiresAt) {
    return {
      expiresAt: null,
      daysRemaining: null,
      expiringSoon: false,
    };
  }
  const expiresMs = new Date(expiresAt).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.ceil((expiresMs - now.getTime()) / dayMs);
  return {
    expiresAt: new Date(expiresMs).toISOString(),
    daysRemaining,
    expiringSoon: daysRemaining <= 30,
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
    throw new Error(`invalid ${label}`);
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
