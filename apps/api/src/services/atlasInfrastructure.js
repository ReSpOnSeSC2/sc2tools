"use strict";

const ATLAS_BASE_URL = "https://cloud.mongodb.com";
const ATLAS_TOKEN_URL = `${ATLAS_BASE_URL}/api/oauth/token`;
const ATLAS_API_VERSION = "2025-03-12";
const TOKEN_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8 * 1000;
const DISK_METRIC_PERIOD = "PT1H";
const PROCESS_METRIC_PERIOD = "PT1H";
const SUSTAINED_SAMPLE_COUNT = 3;
const MAX_CLUSTER_PROCESSES = 9;
// Atlas's largest page. A default Cloud Backup policy keeps ~30 snapshots,
// so one page always holds the newest one.
const BACKUP_SNAPSHOT_PAGE_SIZE = 500;
const SNAPSHOT_STATUSES = new Set(["queued", "inProgress", "completed", "failed"]);
const BACKUP_FREQUENCIES = ["hourly", "daily", "weekly", "monthly", "yearly"];
const RETENTION_UNITS = new Set(["days", "weeks", "months", "years"]);
const MAX_RETENTION_ITEMS = 10;
// Atlas Flex clusters live under their own Admin API resource (the classic
// clusters API stopped serving them in January 2026). Flex is billed hourly
// by operations-per-second band up to a $30 monthly cap, includes 5 GB of
// data (uncompressed documents plus indexes), and keeps a fixed policy of
// one daily snapshot with the last 8 retained.
const FLEX_TIER = "FLEX";
const FLEX_API_VERSION = "2024-11-13";
// A Flex cluster that runs a whole cycle costs at least the base band's
// hourly price ($0.011, about $8 a month) for the cycle's hours and at most
// the cap ($30), so a run rate outside that range is a measurement artifact
// (for example a first line item that starts before the cluster existed).
const FLEX_BASE_CENTS_PER_HOUR = 1.1;
const FLEX_MONTHLY_CAP_CENTS = 3_000;
const MAX_CYCLE_HOURS = 31 * 24;
const FLEX_STORAGE_LIMIT_GB = 5;
const FLEX_SNAPSHOT_RETENTION_DAYS = 8;
/** @type {Readonly<Record<string, string>>} */
const FLEX_SNAPSHOT_STATUSES = Object.freeze({
  PENDING: "queued",
  QUEUED: "queued",
  RUNNING: "inProgress",
  COMPLETED: "completed",
  FAILED: "failed",
});
// The cluster kind rarely changes, so one probe per window is enough and a
// Flex cluster never hits the classic API. It can change in place (Atlas
// keeps the name when upgrading Flex to a dedicated tier), so a 400/404 from
// a read that assumed the cached kind drops the cache early.
const CLUSTER_KIND_TTL_MS = 6 * 60 * 60 * 1000;
// After a transient probe failure the last known kind is reused this long,
// so a sustained outage costs one probe per window instead of one per call.
const STALE_KIND_RETRY_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   kind: "flex"|"dedicated",
 *   flexCluster: Record<string, any>|null,
 *   probeError?: unknown,
 * }} ClusterKindResult
 */

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
    /** @type {"flex"|"dedicated"|null} */
    this._clusterKindValue = null;
    this._clusterKindFreshUntil = 0;
    /** @type {Promise<ClusterKindResult>|null} */
    this._clusterKindInflight = null;
  }

  async snapshot() {
    // One kind probe feeds both reads: the cluster read reuses a fresh Flex
    // response, and billing learns the tier ("flex", "dedicated" or unknown)
    // even when the cluster read itself fails. The invoice request runs
    // alongside the probe instead of waiting for it.
    const kind = this._resolveClusterKind();
    const knownKind = kind.then((resolved) => resolved.kind, () => null);
    const invoices = this._pendingInvoices();
    const [clusterResult, invoiceResult] = await Promise.allSettled([
      kind.then((resolved) => this._clusterSnapshot(resolved)),
      Promise.all([invoices, knownKind]).then(([raw, tier]) => (
        parsePendingInvoices(raw, this._billingTarget(), { kind: tier })
      )),
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

  /**
   * Cloud Backup health for the configured cluster: the newest completed
   * snapshot, the state of the newest snapshot of any kind, the schedule's
   * next run, its retention policy and point-in-time restore. Snapshot ids,
   * regions, hostnames and storage details never leave this method.
   *
   * Needs the Project Read Only role. The snapshot list is required; the
   * schedule and cluster reads only add detail, so either failing leaves
   * those fields null instead of failing the check.
   */
  async backupStatus() {
    if (await this._clusterKind() === "flex") return this._flexBackupStatus();
    const project = encodeURIComponent(this.config.projectId);
    const name = encodeURIComponent(this.config.clusterName);
    const cluster = `/api/atlas/v2/groups/${project}/clusters/${name}`;
    const [snapshots, schedule, settings] = await Promise.allSettled([
      this._kindSensitive(() => this._apiJson(
        `${cluster}/backup/snapshots?itemsPerPage=${BACKUP_SNAPSHOT_PAGE_SIZE}`,
      )),
      this._apiJson(`${cluster}/backup/schedule`),
      this._apiJson(cluster),
    ]);
    if (snapshots.status === "rejected") throw snapshots.reason;
    const parsedSchedule = parseBackupSchedule(
      schedule.status === "fulfilled" ? schedule.value : null,
    );
    const clusterBackup = parseClusterBackupSettings(
      settings.status === "fulfilled" ? settings.value : null,
    );
    return {
      ...parseBackupSnapshots(snapshots.value),
      nextSnapshotAt: parsedSchedule.nextSnapshotAt,
      retention: parsedSchedule.retention,
      cloudBackupEnabled: clusterBackup.cloudBackupEnabled,
      pointInTime: {
        enabled: clusterBackup.pitEnabled,
        windowDays: clusterBackup.pitEnabled
          ? parsedSchedule.restoreWindowDays
          : null,
      },
    };
  }

  /**
   * Flex backups follow Atlas's fixed policy: one daily snapshot, the last
   * 8 kept, no point-in-time restore and no way to turn backups off. Only
   * the snapshot list is read; the policy is constant for the tier.
   */
  async _flexBackupStatus() {
    const raw = await this._kindSensitive(() => this._apiJson(
      `${this._flexClusterPath()}/backup/snapshots`
        + `?itemsPerPage=${BACKUP_SNAPSHOT_PAGE_SIZE}`,
      FLEX_API_VERSION,
    ));
    return {
      ...parseFlexBackupSnapshots(raw),
      nextSnapshotAt: null,
      retention: [{
        frequency: "daily",
        everyHours: null,
        keep: FLEX_SNAPSHOT_RETENTION_DAYS,
        unit: "days",
      }],
      cloudBackupEnabled: true,
      pointInTime: { enabled: false, windowDays: null },
    };
  }

  /** @returns {Promise<"flex"|"dedicated">} */
  async _clusterKind() {
    return (await this._resolveClusterKind()).kind;
  }

  /**
   * Whether the configured cluster is Flex or dedicated, cached for
   * CLUSTER_KIND_TTL_MS, with concurrent callers sharing one probe.
   *
   * @returns {Promise<ClusterKindResult>}
   */
  _resolveClusterKind() {
    const nowMs = this._now().getTime();
    if (this._clusterKindValue && nowMs < this._clusterKindFreshUntil) {
      return Promise.resolve({ kind: this._clusterKindValue, flexCluster: null });
    }
    if (!this._clusterKindInflight) {
      const pending = this._probeClusterKind();
      this._clusterKindInflight = pending;
      const clear = () => {
        if (this._clusterKindInflight === pending) this._clusterKindInflight = null;
      };
      pending.then(clear, clear);
    }
    return this._clusterKindInflight;
  }

  /**
   * A 400/404 from the Flex resource means "dedicated". Any other failure
   * keeps the last known kind (for STALE_KIND_RETRY_MS), so a transient
   * outage neither changes the tier nor fails a read that only needs it, and
   * hands the failure on so the cluster read does not repeat the request
   * that just failed; it propagates only before a kind has ever been
   * learned. A successful probe returns the Flex resource so the cluster
   * read does not fetch it twice.
   *
   * @returns {Promise<ClusterKindResult>}
   */
  async _probeClusterKind() {
    try {
      const flexCluster = await this._apiJson(
        this._flexClusterPath(),
        FLEX_API_VERSION,
      );
      this._rememberClusterKind("flex");
      return { kind: "flex", flexCluster };
    } catch (err) {
      if (isTierMismatch(err)) {
        this._rememberClusterKind("dedicated");
        return { kind: "dedicated", flexCluster: null };
      }
      if (this._clusterKindValue) {
        this._clusterKindFreshUntil = this._now().getTime() + STALE_KIND_RETRY_MS;
        return { kind: this._clusterKindValue, flexCluster: null, probeError: err };
      }
      throw err;
    }
  }

  /** @param {"flex"|"dedicated"} kind */
  _rememberClusterKind(kind) {
    this._clusterKindValue = kind;
    this._clusterKindFreshUntil = this._now().getTime() + CLUSTER_KIND_TTL_MS;
  }

  /**
   * Runs a read that assumes the cached kind. A 400/404 means the cluster
   * may have changed tier in place, so the cache is dropped and the next
   * call probes again instead of trusting it for the rest of its window.
   *
   * @template T
   * @param {() => Promise<T>} read
   * @returns {Promise<T>}
   */
  async _kindSensitive(read) {
    try {
      return await read();
    } catch (err) {
      if (isTierMismatch(err)) this._clusterKindFreshUntil = 0;
      throw err;
    }
  }

  _flexClusterPath() {
    const project = encodeURIComponent(this.config.projectId);
    const name = encodeURIComponent(this.config.clusterName);
    return `/api/atlas/v2/groups/${project}/flexClusters/${name}`;
  }

  /** @param {ClusterKindResult} [resolved] */
  async _clusterSnapshot(resolved) {
    const { kind, flexCluster, probeError } = resolved
      ?? await this._resolveClusterKind();
    if (kind === "flex") {
      // The probe just failed on this very resource; do not ask again.
      if (!flexCluster && probeError) throw probeError;
      return parseFlexCluster(
        flexCluster
          ?? await this._kindSensitive(() => this._apiJson(
            this._flexClusterPath(),
            FLEX_API_VERSION,
          )),
      );
    }
    const project = encodeURIComponent(this.config.projectId);
    const name = encodeURIComponent(this.config.clusterName);
    const raw = await this._kindSensitive(() => this._apiJson(
      `/api/atlas/v2/groups/${project}/clusters/${name}`,
    ));
    const parsed = parseCluster(raw);
    let operational = null;
    try {
      operational = await this._operationalSnapshot(raw);
    } catch {
      // Cluster configuration remains useful if metrics are temporarily
      // unavailable, still warming up, or the process list is paginated.
    }
    return { ...parsed, ...operational };
  }

  _pendingInvoices() {
    const org = encodeURIComponent(this.config.orgId);
    return this._apiJson(`/api/atlas/v2/orgs/${org}/invoices/pending`);
  }

  _billingTarget() {
    return {
      projectId: this.config.projectId,
      clusterName: this.config.clusterName,
    };
  }

  /** @param {Record<string, any>} cluster */
  async _operationalSnapshot(cluster) {
    const project = encodeURIComponent(this.config.projectId);
    const processes = await this._apiJson(
      `/api/atlas/v2/groups/${project}/processes?itemsPerPage=100`,
    );
    const processWindow = selectClusterProcessWindow(
      cluster,
      processes?.results || [],
    );
    const clusterProcesses = processWindow.processes;
    if (clusterProcesses.length === 0) {
      throw atlasError("atlas_cluster_process_missing");
    }
    const rows = await Promise.allSettled(clusterProcesses.map(
      async (process) => {
        const [diskResult, performanceResult] = await Promise.allSettled([
          this._diskSnapshot(process),
          this._performanceSnapshot(process),
        ]);
        return {
          disk: diskResult.status === "fulfilled" ? diskResult.value : null,
          performance: performanceResult.status === "fulfilled"
            ? performanceResult.value
            : null,
        };
      },
    ));
    const values = rows
      .filter((row) => row.status === "fulfilled")
      .map((row) => row.value);
    const diskRows = values
      .map((row) => row.disk)
      .filter((row) => row !== null);
    const performanceRows = values
      .map((row) => row.performance)
      .filter((row) => row !== null);
    return {
      ...worstDisk(diskRows),
      performance: aggregateProcessPerformance(
        performanceRows,
        processWindow.expectedProcessCount,
      ),
    };
  }

  /** @param {Record<string, any>} process */
  async _diskSnapshot(process) {
    const project = encodeURIComponent(this.config.projectId);
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

  /** @param {Record<string, any>} process */
  async _performanceSnapshot(process) {
    const project = encodeURIComponent(this.config.projectId);
    const processId = encodeURIComponent(String(process.id || ""));
    const query = "granularity=PT5M&period=" + PROCESS_METRIC_PERIOD
      + "&m=SYSTEM_NORMALIZED_CPU_USER"
      + "&m=SYSTEM_NORMALIZED_CPU_KERNEL"
      + "&m=CACHE_FILL_RATIO"
      + "&m=CONNECTIONS";
    const raw = await this._apiJson(
      `/api/atlas/v2/groups/${project}/processes/${processId}`
        + `/measurements?${query}`,
    );
    const parsed = parseProcessMeasurements(raw);
    if (!parsed) throw atlasError("atlas_process_metrics_unavailable");
    return parsed;
  }

  /** @param {string} path @param {string} [version] Admin API version date */
  async _apiJson(path, version = ATLAS_API_VERSION) {
    let token = await this._token();
    let response = await this._fetchJson(`${ATLAS_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        accept: `application/vnd.atlas.${version}+json`,
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
          accept: `application/vnd.atlas.${version}+json`,
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
  const effective = Array.isArray(raw?.effectiveReplicationSpecs)
    && raw.effectiveReplicationSpecs.length > 0
    ? raw.effectiveReplicationSpecs
    : null;
  const specs = effective || raw?.replicationSpecs;
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
    performance: null,
  };
}

/**
 * A Flex cluster reports provider settings only: no node specs, disk
 * measurements or host metrics, and storage never auto-expands.
 *
 * @param {Record<string, any>} raw
 */
function parseFlexCluster(raw) {
  const settings = raw?.providerSettings || {};
  return {
    tier: FLEX_TIER,
    provider: nullableText(settings.backingProviderName ?? settings.providerName),
    region: nullableText(settings.regionName),
    provisionedDiskGb: finiteNonNegative(
      settings.diskSizeGB ?? FLEX_STORAGE_LIMIT_GB,
      "atlas provisioned disk",
    ),
    autoExpandStorage: false,
    diskUsedBytes: null,
    diskCapacityBytes: null,
    diskMeasuredAt: null,
    performance: null,
  };
}

/**
 * Flex snapshots use start/finish times and upper-case statuses. They are
 * mapped onto the dedicated-cluster shape so one parser decides freshness.
 *
 * @param {Record<string, any>} raw
 */
function parseFlexBackupSnapshots(raw) {
  const rows = Array.isArray(raw?.results) ? raw.results : [];
  return parseBackupSnapshots({
    results: rows.map((/** @type {any} */ row) => {
      const status = FLEX_SNAPSHOT_STATUSES[String(row?.status || "").toUpperCase()]
        || "unknown";
      return {
        createdAt: status === "completed"
          ? (row?.finishTime ?? row?.startTime ?? row?.scheduledTime)
          : (row?.startTime ?? row?.scheduledTime),
        status,
      };
    }),
  });
}

/**
 * A Flex run rate stays inside the tier's price range for the cycle:
 * never above the $30 cap, and never below the base band's price for the
 * cycle's hours, which a short or partly unbilled first window (a first line
 * item that starts before the cluster existed) would otherwise suggest.
 * Line-item discounts scale that floor instead of dropping it. A run rate
 * is never shown below what has already posted this cycle. The basis says
 * which of these set the number, so pages can word it honestly.
 *
 * @param {{
 *   projected: number|null,
 *   postedCycleCents: number,
 *   grossCents: number,
 *   discountCents: number,
 *   cycleStart: string|null,
 *   cycleEnd: string|null,
 * }} input
 * @returns {{cents: number|null, basis: "posted"|"flex_base_price"|"flex_cap"|null}}
 */
function flexRunRate(input) {
  const { projected, postedCycleCents, grossCents, discountCents } = input;
  if (projected === null || !Number.isSafeInteger(projected)) {
    return { cents: projected, basis: null };
  }
  // A billing cycle is at most 31 days; a stray early line date must not
  // stretch the floor beyond a month's base price.
  const cycleHours = input.cycleStart && input.cycleEnd
    ? Math.min(
      MAX_CYCLE_HOURS,
      (new Date(input.cycleEnd).getTime() - new Date(input.cycleStart).getTime())
        / 3_600_000,
    )
    : Number.NaN;
  const netShare = grossCents > 0
    ? Math.min(1, Math.max(0, grossCents - discountCents) / grossCents)
    : 0;
  const floor = Number.isFinite(cycleHours) && cycleHours > 0
    ? Math.round(FLEX_BASE_CENTS_PER_HOUR * cycleHours * netShare)
    : 0;
  /** @type {"posted"|"flex_base_price"|"flex_cap"} */ let basis = "posted";
  let cents = projected;
  if (floor > 0 && cents < floor) {
    cents = floor;
    basis = "flex_base_price";
  }
  if (cents > FLEX_MONTHLY_CAP_CENTS) {
    cents = FLEX_MONTHLY_CAP_CENTS;
    basis = "flex_cap";
  }
  if (cents < postedCycleCents) {
    cents = postedCycleCents;
    basis = "posted";
  }
  return { cents, basis };
}

/**
 * Newest completed snapshot plus the state of the newest snapshot of any
 * kind (an in-progress or failed run is newer than the last good one).
 * Only timestamps and an allowlisted status survive.
 *
 * @param {Record<string, any>} raw
 */
function parseBackupSnapshots(raw) {
  const rows = Array.isArray(raw?.results) ? raw.results : [];
  /** @type {string|null} */ let lastSnapshotAt = null;
  /** @type {{createdAt: string, status: string}|null} */ let latest = null;
  let completedSnapshotCount = 0;
  for (const row of rows) {
    const createdAt = validIso(row?.createdAt);
    if (!createdAt) continue;
    const status = SNAPSHOT_STATUSES.has(row?.status) ? row.status : "unknown";
    if (!latest || createdAt > latest.createdAt) latest = { createdAt, status };
    if (status !== "completed") continue;
    completedSnapshotCount += 1;
    if (!lastSnapshotAt || createdAt > lastSnapshotAt) lastSnapshotAt = createdAt;
  }
  return {
    lastSnapshotAt,
    latestStatus: latest ? latest.status : null,
    completedSnapshotCount,
  };
}

/**
 * Next scheduled run, retention per frequency and the continuous-backup
 * window from the cluster's backup schedule. A missing or unreadable
 * schedule yields nulls rather than an error.
 *
 * @param {Record<string, any>|null} raw
 */
function parseBackupSchedule(raw) {
  const policies = Array.isArray(raw?.policies) ? raw.policies : [];
  const retention = policies
    .flatMap((/** @type {any} */ policy) => Array.isArray(policy?.policyItems)
      ? policy.policyItems
      : [])
    .map(parseRetentionItem)
    .filter((/** @type {any} */ item) => item !== null)
    .sort((/** @type {any} */ left, /** @type {any} */ right) =>
      BACKUP_FREQUENCIES.indexOf(left.frequency)
        - BACKUP_FREQUENCIES.indexOf(right.frequency))
    .slice(0, MAX_RETENTION_ITEMS);
  return {
    nextSnapshotAt: validIso(raw?.nextSnapshot),
    retention,
    restoreWindowDays: positiveInteger(raw?.restoreWindowDays),
  };
}

/**
 * One schedule policy item as a plain summary. Atlas's frequencyInterval
 * only means "every N hours" for hourly items (for weekly/monthly it is a
 * day of the week/month), so it is kept for hourly items only.
 *
 * @param {Record<string, any>} item
 */
function parseRetentionItem(item) {
  const frequency = String(item?.frequencyType || "");
  const unit = String(item?.retentionUnit || "");
  const keep = positiveInteger(item?.retentionValue);
  if (!BACKUP_FREQUENCIES.includes(frequency)
    || !RETENTION_UNITS.has(unit)
    || keep === null) {
    return null;
  }
  return {
    frequency,
    everyHours: frequency === "hourly"
      ? positiveInteger(item?.frequencyInterval)
      : null,
    keep,
    unit,
  };
}

/** @param {Record<string, any>|null} raw */
function parseClusterBackupSettings(raw) {
  return {
    cloudBackupEnabled: typeof raw?.backupEnabled === "boolean"
      ? raw.backupEnabled
      : null,
    pitEnabled: typeof raw?.pitEnabled === "boolean" ? raw.pitEnabled : null,
  };
}

/**
 * Sums the configured cluster's line items, and separately the net charges
 * of the same project's other clusters (admin-only context: public pages
 * count only the configured cluster).
 *
 * @param {any[]} invoices
 * @param {{projectId: string, clusterName: string}} target
 */
function collectLineItems(invoices, target) {
  const totals = {
    grossCents: 0,
    discountCents: 0,
    lineItemCount: 0,
    flexLineItemCount: 0,
    otherClustersCents: 0,
    categoryCents: { compute: 0, storage: 0, transfer: 0, other: 0 },
    /** @type {string[]} */ otherClustersLineEnds: [],
    /** @type {string[]} */ cycleStarts: [],
    /** @type {string[]} */ cycleEnds: [],
    /** @type {string[]} */ invoiceUpdates: [],
    /** @type {string[]} */ lineEnds: [],
    /** @type {string[]} */ clusterStarts: [],
  };
  for (const invoice of invoices) {
    pushDate(totals.cycleStarts, invoice?.startDate);
    pushDate(totals.cycleEnds, invoice?.endDate);
    pushDate(totals.invoiceUpdates, invoice?.updated);
    for (const item of Array.isArray(invoice?.lineItems)
      ? invoice.lineItems
      : []) {
      if (String(item?.groupId || "") !== target.projectId) continue;
      const clusterName = String(item?.clusterName || "");
      const itemGross = safeInteger(
        item?.totalPriceCents ?? 0,
        "atlas line item total",
      );
      const itemDiscount = nonNegativeSafeInteger(
        item?.discountCents ?? 0,
        "atlas discount",
      );
      if (clusterName !== target.clusterName) {
        if (clusterName) {
          totals.otherClustersCents = safeAdd(
            totals.otherClustersCents,
            itemGross - itemDiscount,
          );
          pushDate(totals.otherClustersLineEnds, item?.endDate ?? item?.created);
        }
        continue;
      }
      totals.grossCents = safeAdd(totals.grossCents, itemGross);
      totals.discountCents = safeAdd(totals.discountCents, itemDiscount);
      const category = atlasCostCategory(item?.sku);
      totals.categoryCents[category] = safeAdd(
        totals.categoryCents[category],
        itemGross - itemDiscount,
      );
      totals.lineItemCount += 1;
      if (isFlexSku(item?.sku)) totals.flexLineItemCount += 1;
      pushDate(totals.cycleStarts, item?.startDate);
      pushDate(totals.clusterStarts, item?.startDate);
      pushDate(totals.lineEnds, item?.endDate ?? item?.created);
    }
  }
  return totals;
}

/**
 * @param {Record<string, any>} raw
 * @param {{projectId: string, clusterName: string}} target
 * @param {{kind?: "flex"|"dedicated"|null}} [options] the cluster kind the
 *   probe reported. A definite answer is authoritative; only when it is
 *   unknown do Flex SKUs on every matching line imply Flex pricing (a cluster
 *   upgraded in place mixes Flex and dedicated lines and is not clamped).
 */
function parsePendingInvoices(raw, target, options = {}) {
  const invoices = Array.isArray(raw?.results)
    ? raw.results
    : (Array.isArray(raw?.lineItems) ? [raw] : []);
  const lines = collectLineItems(invoices, target);
  const otherClusters = {
    otherClustersPostedCents: lines.otherClustersCents,
    otherClustersBilledThrough: maxIso(lines.otherClustersLineEnds),
  };
  // A valid pending-invoice response with no lines for the configured
  // project/cluster is not evidence of a $0 monthly run rate. It can mean
  // provider posting lag or a target mismatch, so preserve the planning
  // fallback instead of projecting zero.
  if (lines.lineItemCount === 0) {
    return {
      ...unavailableBilling("atlas_billing_no_matching_line_items"),
      ...otherClusters,
    };
  }
  const { grossCents, discountCents } = lines;
  const cycleStart = minIso(lines.cycleStarts);
  const cycleEnd = maxIso(lines.cycleEnds);
  const through = billedThrough(lines.lineEnds, lines.invoiceUpdates);
  const postedCycleCents = grossCents - discountCents;
  const projected = projectCycleCost({
    postedCycleCents,
    cycleStart,
    cycleEnd,
    postedThrough: through,
    billedSince: minIso(lines.clusterStarts),
  });
  const flexPricing = options.kind === "flex"
    || (options.kind == null
      && lines.flexLineItemCount > 0
      && lines.flexLineItemCount === lines.lineItemCount);
  const runRate = flexPricing
    ? flexRunRate({
      projected,
      postedCycleCents,
      grossCents,
      discountCents,
      cycleStart,
      cycleEnd,
    })
    : { cents: projected, basis: projected === null ? null : "posted" };
  const projectedMonthlyRunRateCents = runRate.cents;
  return {
    available: true,
    cycleStart,
    cycleEnd,
    postedThrough: through,
    postedCycleCents,
    categoryCents: lines.categoryCents,
    projectedMonthlyRunRateCents,
    projectedMonthlyRunRateUsd: projectedMonthlyRunRateCents === null
      ? null
      : centsToUsd(projectedMonthlyRunRateCents),
    projectionBasis: runRate.basis,
    clusterPostedGrossUsd: centsToUsd(grossCents),
    clusterPostedDiscountUsd: centsToUsd(discountCents),
    clusterPostedNetUsd: centsToUsd(grossCents - discountCents),
    lineItemCount: lines.lineItemCount,
    ...otherClusters,
    currency: "USD",
    source: "atlas_pending_invoice",
    lagDaysApprox: 1,
    errorCode: null,
  };
}

/** @param {string} [errorCode] */
function unavailableBilling(errorCode = "atlas_billing_unavailable") {
  return {
    available: false,
    cycleStart: null,
    cycleEnd: null,
    postedThrough: null,
    postedCycleCents: null,
    categoryCents: null,
    projectedMonthlyRunRateCents: null,
    projectedMonthlyRunRateUsd: null,
    /** @type {"posted"|"flex_base_price"|"flex_cap"|null} */
    projectionBasis: null,
    clusterPostedGrossUsd: null,
    clusterPostedDiscountUsd: null,
    clusterPostedNetUsd: null,
    lineItemCount: 0,
    /** @type {number|null} */
    otherClustersPostedCents: null,
    /** @type {string|null} */
    otherClustersBilledThrough: null,
    currency: "USD",
    source: "atlas_pending_invoice",
    lagDaysApprox: 1,
    errorCode,
  };
}

/**
 * The configured cluster's charges run through the end of its newest line
 * item. The invoice's "updated" time moves whenever any line in the org
 * posts (usually hours after the last billed hour), so measuring to it would
 * spread the posted charges over unbilled time. It only caps a line that
 * claims to end later, and stands in when no line carries a date.
 *
 * @param {string[]} lineEnds
 * @param {string[]} invoiceUpdates
 */
function billedThrough(lineEnds, invoiceUpdates) {
  const lineEnd = maxIso(lineEnds);
  const updated = maxIso(invoiceUpdates);
  if (!lineEnd) return updated;
  if (!updated) return lineEnd;
  return new Date(lineEnd).getTime() <= new Date(updated).getTime()
    ? lineEnd
    : updated;
}

/** @param {unknown} sku */
function isFlexSku(sku) {
  return String(sku || "").toUpperCase().includes("FLEX");
}

/**
 * A 400/404 from a tier-specific resource: the cluster is not (or no
 * longer) that tier.
 *
 * @param {unknown} err
 */
function isTierMismatch(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === "atlas_admin_http_404" || code === "atlas_admin_http_400";
}

/** @param {unknown} sku */
function atlasCostCategory(sku) {
  const value = String(sku || "").toUpperCase();
  // Flex is one all-inclusive hourly charge (storage, backups and data
  // transfer are part of the band price), so it is the cluster's compute.
  if (isFlexSku(value)) return "compute";
  if (value.includes("DATA_TRANSFER")) return "transfer";
  if (value.includes("STORAGE")) return "storage";
  if (value.includes("INSTANCE")) return "compute";
  return "other";
}

/**
 * Linear run-rate projection over the provider's real cycle boundaries.
 * Charges typically post the next day, so this remains an estimate and is
 * never represented as an invoice total. A cluster that started billing
 * mid-cycle is measured from its first line item, so its charges are not
 * spread over days it did not exist (which would understate its run rate).
 *
 * @param {{
 *   postedCycleCents: number,
 *   cycleStart: string|null,
 *   cycleEnd: string|null,
 *   postedThrough: string|null,
 *   billedSince?: string|null,
 * }} input
 */
function projectCycleCost(input) {
  if (!input.cycleStart || !input.cycleEnd || !input.postedThrough) return null;
  const start = new Date(input.cycleStart).getTime();
  const end = new Date(input.cycleEnd).getTime();
  const through = new Date(input.postedThrough).getTime();
  const billedSinceMs = input.billedSince
    ? new Date(input.billedSince).getTime()
    : Number.NaN;
  const since = Number.isFinite(billedSinceMs)
    ? Math.max(start, billedSinceMs)
    : start;
  const cycleMs = end - start;
  const elapsedMs = Math.min(end, through) - since;
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (cycleMs <= 0 || elapsedMs < oneDayMs) return null;
  const projected = Math.round(input.postedCycleCents * cycleMs / elapsedMs);
  return safeInteger(projected, "atlas projected cycle cost");
}

/** @param {Record<string, any>} cluster @param {any[]} rows */
function selectClusterProcess(cluster, rows) {
  return selectClusterProcesses(cluster, rows)[0] || null;
}

/** @param {Record<string, any>} cluster @param {any[]} rows */
function selectClusterProcesses(cluster, rows) {
  const hosts = connectionHosts(cluster?.connectionStrings?.standard);
  const matches = rows.filter((row) => {
    const hostname = String(row?.hostname || "").toLowerCase();
    const alias = String(row?.userAlias || "").toLowerCase();
    const id = String(row?.id || "").toLowerCase();
    return hosts.has(hostname) || hosts.has(alias) || hosts.has(id);
  });
  return matches.sort((left, right) => {
    const leftPrimary = String(left?.typeName || "").includes("PRIMARY");
    const rightPrimary = String(right?.typeName || "").includes("PRIMARY");
    return Number(rightPrimary) - Number(leftPrimary);
  });
}

/**
 * Keep provider fan-out bounded while preserving the true matched node count.
 * A cluster larger than the cap must report incomplete coverage rather than
 * incorrectly claiming that all electable processes were measured.
 *
 * @param {Record<string, any>} cluster
 * @param {any[]} rows
 */
function selectClusterProcessWindow(cluster, rows) {
  const matches = selectClusterProcesses(cluster, rows);
  return {
    processes: matches.slice(0, MAX_CLUSTER_PROCESSES),
    expectedProcessCount: matches.length,
  };
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

/** @param {Record<string, any>} raw */
function parseProcessMeasurements(raw) {
  const rows = Array.isArray(raw?.measurements) ? raw.measurements : [];
  const user = measurementPoints(rows, "SYSTEM_NORMALIZED_CPU_USER");
  const kernel = measurementPoints(rows, "SYSTEM_NORMALIZED_CPU_KERNEL");
  const cache = measurementPoints(rows, "CACHE_FILL_RATIO", true);
  const connections = measurementPoints(rows, "CONNECTIONS");
  const cpu = combinePointSeries(user, kernel);
  const cpuStats = numericStats(cpu);
  const cacheStats = numericStats(cache);
  const connectionStats = numericStats(connections);
  if (!cpuStats && !cacheStats && !connectionStats) return null;
  return {
    scope: "single_electable_process",
    windowMinutes: 60,
    sustainedWindowMinutes: 15,
    measuredAt: maxIso(/** @type {string[]} */ ([
      cpuStats?.measuredAt,
      cacheStats?.measuredAt,
      connectionStats?.measuredAt,
    ].filter((value) => typeof value === "string"))),
    cpu: stripStatsTimestamp(cpuStats),
    cache: stripStatsTimestamp(cacheStats),
    connections: stripNumberStatsTimestamp(connectionStats),
  };
}

/** @param {Array<Record<string, any>>} rows */
function worstDisk(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort((left, right) => {
    const leftCapacity = Number(left.diskCapacityBytes) || 0;
    const rightCapacity = Number(right.diskCapacityBytes) || 0;
    const leftRatio = leftCapacity > 0
      ? Number(left.diskUsedBytes) / leftCapacity
      : -1;
    const rightRatio = rightCapacity > 0
      ? Number(right.diskUsedBytes) / rightCapacity
      : -1;
    return rightRatio - leftRatio;
  })[0];
}

/**
 * Atlas returns host measurements per process. Capacity advice uses the worst
 * electable-node aggregate, never one selected primary, because a secondary
 * under pressure can become primary after a failover.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {number} expectedProcessCount
 */
function aggregateProcessPerformance(rows, expectedProcessCount) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return {
    scope: "cluster_electable_processes_worst_case",
    processCount: rows.length,
    expectedProcessCount,
    complete: rows.length === expectedProcessCount,
    windowMinutes: 60,
    sustainedWindowMinutes: 15,
    measuredAt: maxIso(rows.map((row) => row.measuredAt).filter(Boolean)),
    cpu: worstPercentStats(rows.map((row) => row.cpu).filter(Boolean)),
    cache: worstPercentStats(rows.map((row) => row.cache).filter(Boolean)),
    connections: worstNumberStats(
      rows.map((row) => row.connections).filter(Boolean),
    ),
  };
}

/** @param {Array<Record<string, any>>} rows */
function worstPercentStats(rows) {
  if (rows.length === 0) return null;
  return {
    averagePercent: maxFinite(rows, "averagePercent"),
    peakPercent: maxFinite(rows, "peakPercent"),
    latestPercent: maxFinite(rows, "latestPercent"),
    recentAveragePercent: maxFinite(rows, "recentAveragePercent"),
    recentSampleCount: minFinite(rows, "recentSampleCount"),
    sampleCount: minFinite(rows, "sampleCount"),
  };
}

/** @param {Array<Record<string, any>>} rows */
function worstNumberStats(rows) {
  if (rows.length === 0) return null;
  return {
    average: maxFinite(rows, "average"),
    peak: maxFinite(rows, "peak"),
    latest: maxFinite(rows, "latest"),
    sampleCount: minFinite(rows, "sampleCount"),
  };
}

/** @param {Array<Record<string, any>>} rows @param {string} field */
function maxFinite(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  return values.length ? roundOne(Math.max(...values)) : null;
}

/** @param {Array<Record<string, any>>} rows @param {string} field */
function minFinite(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

/**
 * @param {any[]} rows
 * @param {string} name
 * @param {boolean} [ratio]
 */
function measurementPoints(rows, name, ratio = false) {
  const metric = rows.find((row) => row?.name === name);
  const dataPoints = Array.isArray(metric?.dataPoints)
    ? metric.dataPoints
    : [];
  /** @type {Array<{timestamp:string,value:number}>} */
  const points = [];
  for (const point of dataPoints) {
    if (point?.value === null
      || point?.value === undefined
      || (typeof point.value === "string" && point.value.trim() === "")) {
      continue;
    }
    const timestamp = validIso(point?.timestamp);
    let value = Number(point?.value);
    if (!timestamp || !Number.isFinite(value) || value < 0) continue;
    if (ratio && value <= 1) value *= 100;
    points.push({
      timestamp,
      value: ratio ? Math.min(100, value) : value,
    });
  }
  return points.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp));
}

/** @param {Array<{timestamp:string,value:number}>} left @param {Array<{timestamp:string,value:number}>} right */
function combinePointSeries(left, right) {
  const values = new Map();
  for (const point of [...left, ...right]) {
    values.set(
      point.timestamp,
      Math.min(100, (values.get(point.timestamp) || 0) + point.value),
    );
  }
  return [...values.entries()]
    .map(([timestamp, value]) => ({ timestamp, value }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** @param {Array<{timestamp:string,value:number}>} points */
function numericStats(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const values = points.map((point) => point.value);
  const recent = points.slice(-SUSTAINED_SAMPLE_COUNT);
  return {
    average: roundOne(
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ),
    peak: roundOne(Math.max(...values)),
    latest: roundOne(points[points.length - 1].value),
    recentAverage: recent.length >= SUSTAINED_SAMPLE_COUNT
      ? roundOne(
        recent.reduce((sum, point) => sum + point.value, 0)
          / SUSTAINED_SAMPLE_COUNT,
      )
      : null,
    recentSampleCount: recent.length,
    sampleCount: points.length,
    measuredAt: points[points.length - 1].timestamp,
  };
}

/** @param {Record<string, any>|null} stats */
function stripStatsTimestamp(stats) {
  if (!stats) return null;
  return {
    averagePercent: stats.average,
    peakPercent: stats.peak,
    latestPercent: stats.latest,
    recentAveragePercent: stats.recentAverage,
    recentSampleCount: stats.recentSampleCount,
    sampleCount: stats.sampleCount,
  };
}

/** @param {Record<string, any>|null} stats */
function stripNumberStatsTimestamp(stats) {
  if (!stats) return null;
  return {
    average: stats.average,
    peak: stats.peak,
    latest: stats.latest,
    sampleCount: stats.sampleCount,
  };
}

/** @param {number} value */
function roundOne(value) {
  return Math.round(value * 10) / 10;
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

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
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
    billedThrough,
    collectLineItems,
    flexRunRate,
    connectionHosts,
    parseBackupSchedule,
    parseBackupSnapshots,
    parseCluster,
    parseFlexBackupSnapshots,
    parseFlexCluster,
    parseDiskMeasurements,
    parseProcessMeasurements,
    parsePendingInvoices,
    projectCycleCost,
    selectClusterProcess,
    selectClusterProcesses,
    selectClusterProcessWindow,
    aggregateProcessPerformance,
    worstDisk,
  },
};
