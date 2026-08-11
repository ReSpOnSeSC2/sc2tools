"use strict";

const ATLAS_BASE_URL = "https://cloud.mongodb.com";
const ATLAS_TOKEN_URL = `${ATLAS_BASE_URL}/api/oauth/token`;
const ATLAS_API_VERSION = "2025-03-12";
const TOKEN_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8 * 1000;
const DISK_METRIC_PERIOD = "PT1H";

/**
 * Read-only MongoDB Atlas control-plane client. It deliberately returns an
 * aggregate allowlist: service-account credentials, org/project identifiers,
 * cluster names, process hostnames, and partition names never leave here.
 */
class AtlasInfrastructureClient {
  /**
   * @param {{
   *   config: {
   *     clientId: string,
   *     clientSecret: string,
   *     orgId: string,
   *     projectId: string,
   *     clusterName: string,
   *     secretExpiresAt?: string|null,
   *   },
   *   fetchImpl?: typeof fetch,
   *   now?: () => Date,
   *   timeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.config) {
      throw new Error("AtlasInfrastructureClient: config required");
    }
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || (() => new Date());
    this.timeoutMs = positiveMs(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
    this._accessToken = null;
    this._tokenFreshUntil = 0;
    this._tokenInflight = null;
  }

  async snapshot() {
    const [clusterResult, invoiceResult] = await Promise.allSettled([
      this._clusterSnapshot(),
      this._billingSnapshot(),
    ]);
    if (clusterResult.status === "rejected"
      && invoiceResult.status === "rejected") {
      throw atlasError("atlas_admin_unavailable");
    }
    const cluster = clusterResult.status === "fulfilled"
      ? clusterResult.value
      : null;
    const billing = invoiceResult.status === "fulfilled"
      ? invoiceResult.value
      : unavailableBilling();
    return {
      available: true,
      measuredAt: this._now().toISOString(),
      cluster,
      billing,
      configErrorCode: cluster ? null : "atlas_cluster_unavailable",
    };
  }

  async _clusterSnapshot() {
    const project = encodeURIComponent(this.config.projectId);
    const name = encodeURIComponent(this.config.clusterName);
    const raw = await this._apiJson(
      `/api/atlas/v2/groups/${project}/clusters/${name}`,
    );
    const parsed = parseCluster(raw);
    let disk = null;
    try {
      disk = await this._diskSnapshot(raw);
    } catch {
      // Cluster configuration remains useful if metrics are temporarily
      // unavailable, still warming up, or the process list is paginated.
    }
    return { ...parsed, ...disk };
  }

  async _billingSnapshot() {
    const org = encodeURIComponent(this.config.orgId);
    const raw = await this._apiJson(
      `/api/atlas/v2/orgs/${org}/invoices/pending`,
    );
    return parsePendingInvoices(raw, {
      projectId: this.config.projectId,
      clusterName: this.config.clusterName,
    });
  }

  /** @param {Record<string, any>} cluster */
  async _diskSnapshot(cluster) {
    const project = encodeURIComponent(this.config.projectId);
    const processes = await this._apiJson(
      `/api/atlas/v2/groups/${project}/processes?itemsPerPage=100`,
    );
    const process = selectClusterProcess(cluster, processes?.results || []);
    if (!process) throw atlasError("atlas_cluster_process_missing");
    const processId = encodeURIComponent(String(process.id || ""));
    const disks = await this._apiJson(
      `/api/atlas/v2/groups/${project}/processes/${processId}/disks`
        + "?itemsPerPage=100",
    );
    /** @type {string[]} */
    const partitions = (Array.isArray(disks?.results) ? disks.results : [])
      .map((/** @type {any} */ row) => String(row?.partitionName || ""))
      .filter(Boolean)
      .slice(0, 5);
    if (partitions.length === 0) {
      throw atlasError("atlas_cluster_disk_missing");
    }
    const measurements = await Promise.allSettled(partitions.map(
      (/** @type {string} */ partition) => {
        const encoded = encodeURIComponent(partition);
        const query = "granularity=PT5M&period=" + DISK_METRIC_PERIOD
          + "&m=DISK_PARTITION_SPACE_USED&m=DISK_PARTITION_SPACE_FREE";
        return this._apiJson(
          `/api/atlas/v2/groups/${project}/processes/${processId}`
            + `/disks/${encoded}/measurements?${query}`,
        );
      },
    ));
    /** @type {Array<{
     *   diskUsedBytes: number,
     *   diskCapacityBytes: number,
     *   diskMeasuredAt: string|null,
     * }>} */
    const candidates = [];
    for (const row of measurements) {
      if (row.status !== "fulfilled") continue;
      const parsed = parseDiskMeasurements(row.value);
      if (parsed) candidates.push(parsed);
    }
    if (candidates.length === 0) {
      throw atlasError("atlas_cluster_disk_metrics_unavailable");
    }
    candidates.sort((a, b) => b.diskCapacityBytes - a.diskCapacityBytes);
    return candidates[0];
  }

  /** @param {string} path */
  async _apiJson(path) {
    let token = await this._token();
    let response = await this._fetchJson(`${ATLAS_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        accept: `application/vnd.atlas.${ATLAS_API_VERSION}+json`,
        authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401) {
      this._accessToken = null;
      this._tokenFreshUntil = 0;
      token = await this._token();
      response = await this._fetchJson(`${ATLAS_BASE_URL}${path}`, {
        method: "GET",
        headers: {
          accept: `application/vnd.atlas.${ATLAS_API_VERSION}+json`,
          authorization: `Bearer ${token}`,
        },
      });
    }
    if (!response.ok) throw atlasError(`atlas_admin_http_${response.status}`);
    return response.body;
  }

  async _token() {
    const nowMs = this._now().getTime();
    if (this._accessToken && nowMs < this._tokenFreshUntil) {
      return this._accessToken;
    }
    if (this._tokenInflight) return this._tokenInflight;
    const pending = this._requestToken();
    this._tokenInflight = pending;
    try {
      return await pending;
    } finally {
      if (this._tokenInflight === pending) this._tokenInflight = null;
    }
  }

  async _requestToken() {
    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
      "utf8",
    ).toString("base64");
    const response = await this._fetchJson(ATLAS_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw atlasError(`atlas_oauth_http_${response.status}`);
    const token = String(response.body?.access_token || "");
    const expiresSec = Number(response.body?.expires_in);
    if (!token || !Number.isFinite(expiresSec) || expiresSec <= 0) {
      throw atlasError("atlas_oauth_invalid_response");
    }
    this._accessToken = token;
    this._tokenFreshUntil = this._now().getTime()
      + Math.max(1_000, (expiresSec * 1000) - TOKEN_SKEW_MS);
    return token;
  }

  /** @param {string} url @param {RequestInit} init */
  async _fetchJson(url, init) {
    if (typeof this.fetchImpl !== "function") {
      throw atlasError("atlas_fetch_unavailable");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.json();
      return {
        ok: Boolean(response.ok),
        status: Number(response.status) || 0,
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  _now() {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("AtlasInfrastructureClient: now() returned invalid date");
    }
    return new Date(value.getTime());
  }
}

/** @param {Record<string, any>} raw */
function parseCluster(raw) {
  const specs = Array.isArray(raw?.replicationSpecs)
    ? raw.replicationSpecs
    : raw?.effectiveReplicationSpecs;
  const regions = (Array.isArray(specs) ? specs : [])
    .flatMap((spec) => Array.isArray(spec?.regionConfigs)
      ? spec.regionConfigs
      : []);
  const region = regions.find((item) => item?.electableSpecs) || regions[0] || {};
  const node = region.electableSpecs
    || region.readOnlySpecs
    || region.analyticsSpecs
    || {};
  const diskGb = finiteNonNegative(
    node.diskSizeGB ?? raw?.diskSizeGB,
    "atlas provisioned disk",
  );
  return {
    tier: nullableText(node.instanceSize ?? raw?.providerSettings?.instanceSizeName),
    provider: nullableText(region.providerName
      ?? raw?.providerSettings?.providerName),
    region: nullableText(region.regionName
      ?? raw?.providerSettings?.regionName),
    provisionedDiskGb: diskGb,
    autoExpandStorage: Boolean(region?.autoScaling?.diskGB?.enabled
      ?? raw?.autoScaling?.diskGB?.enabled),
    diskUsedBytes: null,
    diskCapacityBytes: null,
    diskMeasuredAt: null,
  };
}

/**
 * @param {Record<string, any>} raw
 * @param {{projectId: string, clusterName: string}} target
 */
function parsePendingInvoices(raw, target) {
  const invoices = Array.isArray(raw?.results)
    ? raw.results
    : (Array.isArray(raw?.lineItems) ? [raw] : []);
  let grossCents = 0;
  let discountCents = 0;
  let lineItemCount = 0;
  const categoryCents = { compute: 0, storage: 0, transfer: 0, other: 0 };
  /** @type {string[]} */ const cycleStarts = [];
  /** @type {string[]} */ const cycleEnds = [];
  /** @type {string[]} */ const postedThrough = [];
  for (const invoice of invoices) {
    pushDate(cycleStarts, invoice?.startDate);
    pushDate(cycleEnds, invoice?.endDate);
    pushDate(postedThrough, invoice?.updated);
    for (const item of Array.isArray(invoice?.lineItems)
      ? invoice.lineItems
      : []) {
      if (String(item?.groupId || "") !== target.projectId
        || String(item?.clusterName || "") !== target.clusterName) continue;
      const itemGross = safeInteger(
        item?.totalPriceCents ?? 0,
        "atlas line item total",
      );
      const itemDiscount = nonNegativeSafeInteger(
        item?.discountCents ?? 0,
        "atlas discount",
      );
      grossCents = safeAdd(grossCents, itemGross);
      discountCents = safeAdd(discountCents, itemDiscount);
      const category = atlasCostCategory(item?.sku);
      categoryCents[category] = safeAdd(
        categoryCents[category],
        itemGross - itemDiscount,
      );
      lineItemCount += 1;
      pushDate(cycleStarts, item?.startDate);
      pushDate(postedThrough, item?.endDate ?? item?.created);
    }
  }
  const cycleStart = minIso(cycleStarts);
  const cycleEnd = maxIso(cycleEnds);
  const through = maxIso(postedThrough);
  const postedCycleCents = grossCents - discountCents;
  const projectedMonthlyRunRateCents = projectCycleCost({
    postedCycleCents,
    cycleStart,
    cycleEnd,
    postedThrough: through,
  });
  return {
    available: true,
    cycleStart,
    cycleEnd,
    postedThrough: through,
    postedCycleCents,
    categoryCents,
    projectedMonthlyRunRateCents,
    projectedMonthlyRunRateUsd: projectedMonthlyRunRateCents === null
      ? null
      : centsToUsd(projectedMonthlyRunRateCents),
    clusterPostedGrossUsd: centsToUsd(grossCents),
    clusterPostedDiscountUsd: centsToUsd(discountCents),
    clusterPostedNetUsd: centsToUsd(grossCents - discountCents),
    lineItemCount,
    currency: "USD",
    source: "atlas_pending_invoice",
    lagDaysApprox: 1,
    errorCode: null,
  };
}

function unavailableBilling() {
  return {
    available: false,
    cycleStart: null,
    cycleEnd: null,
    postedThrough: null,
    postedCycleCents: null,
    categoryCents: null,
    projectedMonthlyRunRateCents: null,
    projectedMonthlyRunRateUsd: null,
    clusterPostedGrossUsd: null,
    clusterPostedDiscountUsd: null,
    clusterPostedNetUsd: null,
    lineItemCount: 0,
    currency: "USD",
    source: "atlas_pending_invoice",
    lagDaysApprox: 1,
    errorCode: "atlas_billing_unavailable",
  };
}

/** @param {unknown} sku */
function atlasCostCategory(sku) {
  const value = String(sku || "").toUpperCase();
  if (value.includes("DATA_TRANSFER")) return "transfer";
  if (value.includes("STORAGE")) return "storage";
  if (value.includes("INSTANCE")) return "compute";
  return "other";
}

/**
 * Linear run-rate projection over the provider's real cycle boundaries.
 * Charges typically post the next day, so this remains an estimate and is
 * never represented as an invoice total.
 *
 * @param {{
 *   postedCycleCents: number,
 *   cycleStart: string|null,
 *   cycleEnd: string|null,
 *   postedThrough: string|null,
 * }} input
 */
function projectCycleCost(input) {
  if (!input.cycleStart || !input.cycleEnd || !input.postedThrough) return null;
  const start = new Date(input.cycleStart).getTime();
  const end = new Date(input.cycleEnd).getTime();
  const through = new Date(input.postedThrough).getTime();
  const cycleMs = end - start;
  const elapsedMs = Math.min(end, through) - start;
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (cycleMs <= 0 || elapsedMs < oneDayMs) return null;
  const projected = Math.round(input.postedCycleCents * cycleMs / elapsedMs);
  return safeInteger(projected, "atlas projected cycle cost");
}

/** @param {Record<string, any>} cluster @param {any[]} rows */
function selectClusterProcess(cluster, rows) {
  const hosts = connectionHosts(cluster?.connectionStrings?.standard);
  const matches = rows.filter((row) => {
    const hostname = String(row?.hostname || "").toLowerCase();
    const alias = String(row?.userAlias || "").toLowerCase();
    const id = String(row?.id || "").toLowerCase();
    return hosts.has(hostname) || hosts.has(alias) || hosts.has(id);
  });
  return matches.find((row) => String(row?.typeName || "").includes("PRIMARY"))
    || matches[0]
    || null;
}

/** @param {unknown} raw */
function connectionHosts(raw) {
  const value = String(raw || "").trim();
  const out = new Set();
  if (!value) return out;
  const authority = value.replace(/^mongodb:\/\//i, "")
    .split("/")[0]
    .split("@")
    .pop();
  for (const hostPort of String(authority || "").split(",")) {
    const normalized = hostPort.trim().toLowerCase();
    if (!normalized) continue;
    out.add(normalized);
    out.add(normalized.replace(/:\d+$/, ""));
  }
  return out;
}

/** @param {Record<string, any>} raw */
function parseDiskMeasurements(raw) {
  const rows = Array.isArray(raw?.measurements) ? raw.measurements : [];
  const used = metricBytes(rows, "DISK_PARTITION_SPACE_USED");
  const free = metricBytes(rows, "DISK_PARTITION_SPACE_FREE");
  if (!used || !free) return null;
  const capacity = safeAdd(used.value, free.value);
  return {
    diskUsedBytes: used.value,
    diskCapacityBytes: capacity,
    diskMeasuredAt: maxIso([used.timestamp, free.timestamp]),
  };
}

/**
 * @param {any[]} rows
 * @param {string} name
 * @returns {{value: number, timestamp: string}|null}
 */
function metricBytes(rows, name) {
  const metric = rows.find((row) => row?.name === name);
  const points = Array.isArray(metric?.dataPoints) ? metric.dataPoints : [];
  const point = [...points].reverse().find((item) => Number.isFinite(item?.value));
  if (!point) return null;
  const timestamp = validIso(point.timestamp);
  if (!timestamp) return null;
  const multiplier = metric?.units === "GIGABYTES" ? 1_000_000_000 : 1;
  return {
    value: nonNegativeSafeInteger(
      Math.round(Number(point.value) * multiplier),
      `atlas ${name}`,
    ),
    timestamp,
  };
}

/** @param {string[]} values */
function minIso(values) {
  return values.length ? ([...values].sort()[0] || null) : null;
}

/** @param {string[]} values */
function maxIso(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort();
  return sorted[sorted.length - 1] || null;
}

/** @param {string[]} values @param {unknown} raw */
function pushDate(values, raw) {
  const value = validIso(raw);
  if (value) values.push(value);
}

/** @param {unknown} raw */
function validIso(raw) {
  const text = String(raw || "");
  const date = new Date(text);
  return text && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** @param {unknown} value @param {string} label */
function finiteNonNegative(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw atlasError(`invalid_${label.replaceAll(" ", "_")}`);
  }
  return number;
}

/** @param {unknown} value @param {string} label */
function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw atlasError(`invalid_${label}`);
  return number;
}

/** @param {unknown} value @param {string} label */
function nonNegativeSafeInteger(value, label) {
  const number = safeInteger(value, label);
  if (number < 0) throw atlasError(`invalid_${label}`);
  return number;
}

/** @param {number} left @param {number} right */
function safeAdd(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw atlasError("atlas_total_out_of_range");
  return sum;
}

/** @param {number} cents */
function centsToUsd(cents) {
  return safeInteger(cents, "atlas cents") / 100;
}

/** @param {unknown} value */
function nullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

/** @param {string} code */
function atlasError(code) {
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
  AtlasInfrastructureClient,
  _internals: {
    atlasCostCategory,
    connectionHosts,
    parseCluster,
    parseDiskMeasurements,
    parsePendingInvoices,
    projectCycleCost,
    selectClusterProcess,
  },
};
