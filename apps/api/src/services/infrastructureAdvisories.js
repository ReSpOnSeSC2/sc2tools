"use strict";

/** @typedef {"healthy"|"watch"|"upgrade"} AdvisoryLevel */

const THRESHOLDS = Object.freeze({
  mongo: Object.freeze({
    disk: Object.freeze({ watch: 70, upgrade: 80 }),
    cpuHourlyAverage: Object.freeze({ watch: 60, upgrade: 75 }),
    cpuSustained: Object.freeze({ watch: 60, upgrade: 75 }),
  }),
  render: Object.freeze({
    cpuSustained: Object.freeze({ watch: 60, upgrade: 80 }),
    memorySustained: Object.freeze({ watch: 70, upgrade: 85 }),
  }),
});

/**
 * Build the authenticated admin response from provider adapters. Every field
 * is explicitly reconstructed; adding an identifier to an upstream response
 * cannot make it leak through this contract.
 *
 * @param {{
 *   asOf: string,
 *   cloudflare: {status?: Record<string, any>, snapshot?: Record<string, any>|null},
 *   mongo?: Record<string, any>|null,
 *   render?: Record<string, any>|null,
 * }} input
 */
function buildInfrastructureAdminSnapshot(input) {
  const cloudflareResult = buildCloudflare(
    input.cloudflare?.status,
    input.cloudflare?.snapshot,
  );
  const mongoResult = buildMongo(input.mongo);
  const renderResult = buildRender(input.render);
  const advisories = [
    ...cloudflareResult.advisories,
    ...mongoResult.advisories,
    ...renderResult.advisories,
  ].sort(compareAdvisories);
  const providers = {
    cloudflare: cloudflareResult.provider,
    mongo: mongoResult.provider,
    render: renderResult.provider,
  };
  return {
    asOf: validIso(input.asOf) || new Date(0).toISOString(),
    overallStatus: highestLevel(Object.values(providers).map(
      (provider) => provider.status,
    )),
    providers,
    advisories,
    thresholds: THRESHOLDS,
  };
}

/** @param {Record<string, any>|undefined} status @param {Record<string, any>|null|undefined} snapshot */
function buildCloudflare(status = {}, snapshot = null) {
  /** @type {any[]} */ const advisories = [];
  const configured = Boolean(status.configured);
  const available = Boolean(status.available && snapshot);
  const stale = Boolean(status.stale || snapshot?.stale);
  if (!configured) {
    advisories.push(advisory(
      "cloudflare",
      "watch",
      "cloudflare_monitoring_not_configured",
      "Connect Cloudflare usage monitoring",
      "R2 is working, but the admin console cannot read live storage and request costs yet.",
      "Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_API_TOKEN in Render.",
    ));
  } else if (!available) {
    advisories.push(advisory(
      "cloudflare",
      "watch",
      "cloudflare_metrics_unavailable",
      "Cloudflare metrics need attention",
      "The latest R2 usage snapshot could not be refreshed.",
      "Check the Account Analytics token and try again after the provider recovers.",
    ));
  } else if (stale) {
    advisories.push(advisory(
      "cloudflare",
      "watch",
      "cloudflare_metrics_stale",
      "Cloudflare metrics are temporarily stale",
      "The latest R2 refresh failed, so the console is showing the last successful usage snapshot.",
      "Treat the cost as historical until Cloudflare refreshes successfully.",
    ));
  }
  const unknownRequests = finiteNumberOrNull(snapshot?.r2?.unknownRequests);
  if (available && unknownRequests !== null && unknownRequests > 0) {
    advisories.push(advisory(
      "cloudflare",
      "watch",
      "cloudflare_unclassified_operations",
      "Review new R2 operations",
      "Cloudflare returned operations that are not in the current cost classifier.",
      "Review the R2 pricing categories before relying on the request-cost estimate.",
      "unknown_requests",
      unknownRequests,
      0,
    ));
  }
  const provider = {
    configured,
    available,
    stale,
    status: highestLevel(advisories.map((item) => item.level)),
    measuredAt: validIso(snapshot?.asOf ?? status.asOf),
    errorCode: safeCode(status.errorCode),
    usage: available ? {
      verifiedOriginalReplays: integerOrNull(
        snapshot?.archive?.verifiedOriginalReplays,
      ),
      storedBytes: integerOrNull(snapshot?.archive?.r2StoredBytes),
      objectCount: integerOrNull(snapshot?.archive?.r2ObjectCount),
      includes: "originals_and_analysis",
      billingCycleStart: validIso(snapshot?.r2?.cycleStart),
      classARequests: integerOrNull(snapshot?.r2?.classARequests),
      classBRequests: integerOrNull(snapshot?.r2?.classBRequests),
      unknownRequests,
    } : null,
    cost: available ? {
      currency: "USD",
      estimate: true,
      scope: "configured_bucket",
      basis: "bucket_run_rate_with_account_wide_free_allowance",
      storageMeasurement: "provider_daily_peak",
      storageMonthlyRunRateUsd: moneyOrNull(
        snapshot?.r2?.estimatedCostUsd?.storageRunRate,
      ),
      classAThisCycleUsd: moneyOrNull(
        snapshot?.r2?.estimatedCostUsd?.classAThisCycle,
      ),
      classBThisCycleUsd: moneyOrNull(
        snapshot?.r2?.estimatedCostUsd?.classBThisCycle,
      ),
      estimatedCurrentMonthlyUsd: moneyOrNull(
        snapshot?.r2?.estimatedCostUsd?.currentMonthly,
      ),
    } : null,
  };
  return { provider, advisories };
}

/** @param {Record<string, any>|null|undefined} source */
function buildMongo(source) {
  /** @type {any[]} */ const advisories = [];
  const atlas = source?.atlas || {};
  const configured = Boolean(atlas.configured);
  const monitoringAvailable = Boolean(atlas.available && atlas.cluster);
  const stale = Boolean(source?.stale);
  const appData = sanitiseAppData(source?.appData);
  if (!configured) {
    advisories.push(advisory(
      "mongo",
      "watch",
      "atlas_monitoring_not_configured",
      "Connect Atlas capacity monitoring",
      "MongoDB is reachable, but Atlas disk, CPU, cache, and billing signals are not connected.",
      "Add the ATLAS_* service-account settings in Render.",
    ));
  } else if (!monitoringAvailable) {
    advisories.push(advisory(
      "mongo",
      "watch",
      "atlas_metrics_unavailable",
      "Atlas metrics need attention",
      "Application storage is available, but the Atlas control-plane snapshot failed.",
      "Check the Atlas service account roles and credential expiry.",
    ));
  } else if (stale) {
    advisories.push(advisory(
      "mongo",
      "watch",
      "atlas_metrics_stale",
      "Atlas capacity metrics are temporarily stale",
      "The current Atlas capacity snapshot could not be refreshed, so the console is showing the last successful values.",
      "Do not make a tier purchase from these values; wait for a successful refresh and recheck sustained utilization.",
    ));
  }
  const credential = sanitiseCredential(atlas.credential);
  if (credential.daysRemaining !== null && credential.daysRemaining <= 30) {
    const expired = credential.daysRemaining <= 0;
    advisories.push(advisory(
      "mongo",
      "watch",
      expired ? "atlas_credential_expired" : "atlas_credential_expiring",
      expired ? "Replace the Atlas credential" : "Rotate the Atlas credential soon",
      expired
        ? "The configured Atlas service-account secret has expired."
        : `The Atlas service-account secret expires in ${credential.daysRemaining} days.`,
      "Create a replacement secret and update Render before monitoring stops.",
      "credential_days_remaining",
      credential.daysRemaining,
      30,
    ));
  }
  const cluster = monitoringAvailable
    ? sanitiseMongoCluster(atlas.cluster)
    : null;
  if (cluster && !stale) {
    const performance = cluster.performance;
    if (!performance?.cpu) {
      advisories.push(advisory(
        "mongo",
        "watch",
        "atlas_cpu_metrics_unavailable",
        "Atlas CPU metrics are unavailable",
        "Atlas returned cluster configuration but no usable CPU window for the matched electable processes.",
        "Check host-metric visibility and permissions before using this snapshot for a tier decision.",
      ));
    } else if (!performance.complete) {
      advisories.push(advisory(
        "mongo",
        "watch",
        "atlas_process_coverage_incomplete",
        "Atlas host-metric coverage is incomplete",
        `Capacity signals cover ${performance.processCount ?? 0} of ${performance.expectedProcessCount ?? 0} matched electable processes.`,
        "Check Atlas process visibility and permissions before using these metrics for a tier decision.",
        "measured_process_count",
        performance.processCount,
        performance.expectedProcessCount,
      ));
    }
    if (cluster.diskUtilizationPercent === null) {
      advisories.push(advisory(
        "mongo",
        "watch",
        "atlas_disk_metrics_unavailable",
        "Atlas storage metrics are unavailable",
        "Atlas returned cluster configuration but no usable disk capacity measurement.",
        "Check disk-metric visibility before relying on the storage threshold.",
      ));
    }
    pushMongoDiskAdvisory(
      advisories,
      cluster.diskUtilizationPercent,
      cluster.autoExpandStorage,
    );
    pushSustainedAdvisory(advisories, {
      provider: "mongo",
      code: "mongo_cpu_utilization",
      title: "MongoDB CPU is running hot",
      message: "Sustained Atlas CPU is nearing the planning limit.",
      action: "Inspect slow queries; if the signal persists, move beyond the current Atlas tier.",
      metricPrefix: "cpu",
      values: cluster.performance?.cpu,
      hourlyThresholds: THRESHOLDS.mongo.cpuHourlyAverage,
      sustainedThresholds: THRESHOLDS.mongo.cpuSustained,
    });
  }
  const billing = atlas.billing || {};
  const projected = moneyOrNull(billing.projectedMonthlyRunRateUsd);
  const planning = moneyOrNull(source?.pricing?.monthlyPlanningEstimateUsd);
  const provider = {
    configured,
    available: Boolean(appData),
    monitoringAvailable,
    stale,
    status: highestLevel(advisories.map((item) => item.level)),
    measuredAt: validIso(atlas.measuredAt ?? appData?.measuredAt),
    errorCode: safeCode(atlas.errorCode),
    appData,
    cluster,
    credential,
    cost: {
      currency: "USD",
      estimate: true,
      pricingMode: projected === null
        ? "planning_fallback"
        : "atlas_projected",
      planningMonthlyUsd: planning,
      projectedMonthlyUsd: projected,
      postedCycleUsd: Number.isSafeInteger(billing.postedCycleCents)
        ? moneyOrNull(billing.postedCycleCents / 100)
        : null,
      postedThrough: validIso(billing.postedThrough),
    },
  };
  return { provider, advisories };
}

/** @param {Record<string, any>|null|undefined} source */
function buildRender(source) {
  /** @type {any[]} */ const advisories = [];
  const configured = Boolean(source?.configured);
  const available = Boolean(source?.available);
  const stale = Boolean(source?.stale);
  if (!configured) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_monitoring_not_configured",
      "Connect Render capacity monitoring",
      "The admin console cannot yet compare API CPU and memory with the current service limits.",
      "Add RENDER_API_KEY in Render; the service ID is injected automatically.",
    ));
  } else if (!available) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_metrics_unavailable",
      "Render metrics need attention",
      "The latest API CPU and memory snapshot could not be refreshed.",
      "Check the Render API key and service ID.",
    ));
  } else if (stale) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_metrics_stale",
      "Render capacity metrics are temporarily stale",
      "The latest Render refresh failed, so the console is showing the last successful CPU and memory window.",
      "Do not purchase a larger instance from these values; wait for a successful refresh and recheck sustained utilization.",
    ));
  }
  const service = available ? {
    plan: safeLabel(source?.service?.plan),
    instanceCount: integerOrNull(
      source?.service?.configuredInstanceCount,
    ),
    suspended: Boolean(source?.service?.suspended),
    autoscalingEnabled: Boolean(source?.service?.autoscalingEnabled),
  } : null;
  const metrics = available ? sanitiseRenderMetrics(source?.metrics) : null;
  if (service?.suspended) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_service_suspended",
      "Render service is suspended",
      "The monitored API service is currently suspended.",
      "Resume the service in Render before expecting production traffic.",
    ));
  }
  if (service && (
    (service.instanceCount ?? 0) > 1 || service.autoscalingEnabled
  )) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_multi_instance_not_ready",
      "Keep the API on one instance",
      "Realtime and rate-limit state are still process-local, so horizontal scaling can split live updates.",
      "Scale vertically to a larger instance until shared realtime state is implemented.",
    ));
  }
  if (available && !metrics?.available) {
    advisories.push(advisory(
      "render",
      "watch",
      "render_metrics_no_samples",
      "Render metrics are not ready yet",
      "The Render service was found, but CPU or memory had no usable samples in the last hour.",
      "Wait for the metrics window to populate, then verify the service ID if this persists.",
    ));
  }
  if (metrics && !stale) {
    pushSustainedAdvisory(advisories, {
      provider: "render",
      code: "render_cpu_utilization",
      title: "Render CPU is nearing its limit",
      message: "The API is using a sustained share of its available CPU.",
      action: "If this persists outside a resync burst, purchase the next larger Render instance.",
      metricPrefix: "cpu",
      values: metrics.cpu,
      sustainedThresholds: THRESHOLDS.render.cpuSustained,
    });
    pushSustainedAdvisory(advisories, {
      provider: "render",
      code: "render_memory_utilization",
      title: "Render memory is nearing its limit",
      message: "The API is using a sustained share of its available memory.",
      action: "Purchase the next larger Render instance before memory pressure causes restarts.",
      metricPrefix: "memory",
      values: metrics.memory,
      sustainedThresholds: THRESHOLDS.render.memorySustained,
    });
  }
  const provider = {
    configured,
    available,
    stale,
    status: highestLevel(advisories.map((item) => item.level)),
    measuredAt: validIso(source?.measuredAt),
    errorCode: safeCode(source?.errorCode),
    service,
    metrics,
    cost: available ? {
      currency: "USD",
      estimate: true,
      monthlyPlanningUsd: moneyOrNull(
        source?.cost?.monthlyPlanningUsd,
      ),
      basis: source?.cost?.monthlyPlanningUsd == null
        ? "not_configured"
        : "operator_configured",
    } : null,
  };
  return { provider, advisories };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitiseAppData(source) {
  if (!source) return null;
  return {
    logicalDataBytes: integerOrNull(source.logicalDataBytes),
    allocatedDocumentBytes: integerOrNull(source.allocatedDocumentBytes),
    allocatedIndexBytes: integerOrNull(source.allocatedIndexBytes),
    allocatedTotalBytes: integerOrNull(source.allocatedTotalBytes),
    measuredAt: validIso(source.measuredAt),
    scope: "sc2tools_database_only",
  };
}

/** @param {Record<string, any>} source */
function sanitiseMongoCluster(source) {
  const used = integerOrNull(source.diskUsedBytes);
  const capacity = integerOrNull(source.diskCapacityBytes);
  return {
    tier: safeLabel(source.tier),
    provisionedDiskGb: finiteNumberOrNull(source.provisionedDiskGb),
    diskUsedBytes: used,
    diskCapacityBytes: capacity,
    diskUtilizationPercent: used !== null
      && capacity !== null
      && capacity > 0
      ? roundPercent((used / capacity) * 100)
      : null,
    diskMeasuredAt: validIso(source.diskMeasuredAt),
    autoExpandStorage: Boolean(source.autoExpandStorage),
    performance: sanitiseMongoPerformance(source.performance),
  };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitiseMongoPerformance(source) {
  if (!source) return null;
  return {
    scope: source.scope === "cluster_electable_processes_worst_case"
      ? source.scope
      : "unknown",
    processCount: integerOrNull(source.processCount),
    expectedProcessCount: integerOrNull(source.expectedProcessCount),
    complete: Boolean(source.complete),
    windowMinutes: integerOrNull(source.windowMinutes),
    sustainedWindowMinutes: integerOrNull(source.sustainedWindowMinutes),
    measuredAt: validIso(source.measuredAt),
    cpu: sanitisePercentStats(source.cpu),
    cache: sanitisePercentStats(source.cache),
    connections: sanitiseNumberStats(source.connections),
  };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitiseRenderMetrics(source) {
  if (!source) return null;
  return {
    available: Boolean(source.available),
    windowMinutes: integerOrNull(source.windowMinutes),
    sustainedWindowMinutes: integerOrNull(source.sustainedWindowMinutes),
    resolutionSeconds: integerOrNull(source.resolutionSeconds),
    measuredAt: validIso(source.measuredAt),
    cpu: sanitisePercentStats(source.cpu),
    memory: sanitisePercentStats(source.memory),
  };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitisePercentStats(source) {
  if (!source) return null;
  return {
    averagePercent: percentOrNull(source.averagePercent),
    peakPercent: percentOrNull(source.peakPercent),
    latestPercent: percentOrNull(source.latestPercent),
    recentAveragePercent: percentOrNull(source.recentAveragePercent),
    recentSampleCount: integerOrNull(source.recentSampleCount),
    sampleCount: integerOrNull(source.sampleCount),
  };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitiseNumberStats(source) {
  if (!source) return null;
  return {
    average: finiteNumberOrNull(source.average),
    peak: finiteNumberOrNull(source.peak),
    latest: finiteNumberOrNull(source.latest),
    sampleCount: integerOrNull(source.sampleCount),
  };
}

/** @param {Record<string, any>|null|undefined} source */
function sanitiseCredential(source) {
  const days = finiteNumberOrNull(source?.daysRemaining);
  return {
    expiresAt: validIso(source?.expiresAt),
    daysRemaining: days,
    expiringSoon: days !== null && days <= 30,
  };
}

/**
 * Atlas storage can expand independently from compute. Even above the action
 * threshold this is a storage warning, not proof that an M-tier purchase is
 * required; the copy points admins to auto-expand/manual storage first.
 *
 * @param {any[]} out
 * @param {unknown} rawValue
 * @param {boolean} autoExpandStorage
 */
function pushMongoDiskAdvisory(out, rawValue, autoExpandStorage) {
  const value = percentOrNull(rawValue);
  if (value === null || value < THRESHOLDS.mongo.disk.watch) return;
  const actionNow = value >= THRESHOLDS.mongo.disk.upgrade;
  out.push(advisory(
    "mongo",
    "watch",
    actionNow ? "mongo_storage_action" : "mongo_disk_utilization_watch",
    actionNow ? "Increase MongoDB storage capacity" : "Watch MongoDB storage",
    actionNow
      ? "Atlas disk use has crossed the storage-action threshold."
      : "Atlas disk use is approaching the storage-action threshold.",
    autoExpandStorage
      ? "Confirm auto-expand has room to grow and manually raise storage if usage is climbing quickly; change compute tier only if its storage ceiling blocks growth."
      : "Enable auto-expand or manually increase Atlas storage; change compute tier only if its storage ceiling blocks growth.",
    "disk_utilization_percent",
    value,
    actionNow
      ? THRESHOLDS.mongo.disk.upgrade
      : THRESHOLDS.mongo.disk.watch,
  ));
}

/**
 * Capacity purchase advice must be based on sustained use, never one peak.
 * Render exposes a 15-minute recent average; Atlas additionally exposes the
 * full-hour average so its documented longer planning window stays visible.
 *
 * @param {any[]} out @param {Record<string, any>} opts
 */
function pushSustainedAdvisory(out, opts) {
  const recent = percentOrNull(opts.values?.recentAveragePercent);
  const recentSamples = integerOrNull(opts.values?.recentSampleCount);
  const hourly = percentOrNull(opts.values?.averagePercent);
  const recentLevel = recent === null || (recentSamples ?? 0) < 3
    ? "healthy"
    : thresholdLevel(recent, opts.sustainedThresholds);
  const hourlyLevel = hourly === null || !opts.hourlyThresholds
    ? "healthy"
    : thresholdLevel(hourly, opts.hourlyThresholds);
  const level = highestLevel([recentLevel, hourlyLevel]);
  if (level === "healthy") return;
  const recentWins = levelRank(recentLevel) >= levelRank(hourlyLevel);
  const value = recentWins ? recent : hourly;
  const thresholds = recentWins
    ? opts.sustainedThresholds
    : opts.hourlyThresholds;
  out.push(advisory(
    opts.provider,
    level,
    `${opts.code}_${level}`,
    opts.title,
    opts.message,
    opts.action,
    `${opts.metricPrefix}_${recentWins ? "sustained" : "hourly_average"}_percent`,
    value,
    thresholds[level],
  ));
}

/**
 * @param {number} value
 * @param {{watch:number,upgrade:number}} thresholds
 * @returns {AdvisoryLevel}
 */
function thresholdLevel(value, thresholds) {
  if (value >= thresholds.upgrade) return "upgrade";
  if (value >= thresholds.watch) return "watch";
  return "healthy";
}

/** @param {unknown[]} values @returns {AdvisoryLevel} */
function highestLevel(values) {
  /** @type {AdvisoryLevel} */
  let best = "healthy";
  for (const value of values) {
    const level = normaliseLevel(value);
    if (levelRank(level) > levelRank(best)) best = level;
  }
  return best;
}

/**
 * @param {"cloudflare"|"mongo"|"render"} provider
 * @param {AdvisoryLevel} level
 * @param {string} code
 * @param {string} title
 * @param {string} message
 * @param {string} action
 * @param {string|null} [metric]
 * @param {number|null} [value]
 * @param {number|null} [threshold]
 */
function advisory(
  provider,
  level,
  code,
  title,
  message,
  action,
  metric = null,
  value = null,
  threshold = null,
) {
  return {
    provider,
    level,
    code,
    title,
    message,
    action,
    metric,
    value,
    threshold,
  };
}

/**
 * @param {{level:AdvisoryLevel,provider:string,code:string}} left
 * @param {{level:AdvisoryLevel,provider:string,code:string}} right
 */
function compareAdvisories(left, right) {
  return (levelRank(right.level) - levelRank(left.level))
    || left.provider.localeCompare(right.provider)
    || left.code.localeCompare(right.code);
}

/** @param {unknown} value @returns {AdvisoryLevel} */
function normaliseLevel(value) {
  return value === "upgrade" || value === "watch" ? value : "healthy";
}

/** @param {AdvisoryLevel} value */
function levelRank(value) {
  if (value === "upgrade") return 2;
  if (value === "watch") return 1;
  return 0;
}

/** @param {unknown} raw */
function validIso(raw) {
  const text = String(raw || "");
  const value = new Date(text);
  return text && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/** @param {unknown} raw */
function safeCode(raw) {
  const value = String(raw || "");
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : null;
}

/** @param {unknown} raw */
function safeLabel(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** @param {unknown} raw */
function integerOrNull(raw) {
  if (raw === null
    || raw === undefined
    || (typeof raw === "string" && raw.trim() === "")) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** @param {unknown} raw */
function finiteNumberOrNull(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** @param {unknown} raw */
function percentOrNull(raw) {
  const value = finiteNumberOrNull(raw);
  return value === null ? null : roundPercent(Math.min(100, Math.max(0, value)));
}

/** @param {unknown} raw */
function moneyOrNull(raw) {
  const value = finiteNumberOrNull(raw);
  return value !== null && value >= 0
    ? Math.round(value * 1000) / 1000
    : null;
}

/** @param {number} value */
function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  THRESHOLDS,
  buildInfrastructureAdminSnapshot,
  _internals: {
    buildCloudflare,
    buildMongo,
    buildRender,
    highestLevel,
    thresholdLevel,
  },
};
