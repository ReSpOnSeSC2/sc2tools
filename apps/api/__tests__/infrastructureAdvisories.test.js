// @ts-nocheck
"use strict";

const {
  buildInfrastructureAdminSnapshot,
} = require("../src/services/infrastructureAdvisories");

const NOW = "2026-08-11T18:00:00.000Z";

function healthyInput() {
  return {
    asOf: NOW,
    cloudflare: {
      status: {
        configured: true,
        available: true,
        stale: false,
        asOf: NOW,
        accountId: "SECRET_ACCOUNT",
      },
      snapshot: {
        asOf: NOW,
        stale: false,
        archive: {
          verifiedOriginalReplays: 100,
          r2StoredBytes: 1_000_000,
          r2ObjectCount: 250,
          bucket: "SECRET_BUCKET",
        },
        r2: {
          cycleStart: "2026-08-01T00:00:00.000Z",
          classARequests: 100,
          classBRequests: 200,
          unknownRequests: 0,
          estimatedCostUsd: {
            storageRunRate: 0,
            classAThisCycle: 0,
            classBThisCycle: 0,
            currentMonthly: 0,
          },
        },
      },
    },
    mongo: {
      appData: {
        logicalDataBytes: 1_000,
        allocatedDocumentBytes: 500,
        allocatedIndexBytes: 250,
        allocatedTotalBytes: 750,
        measuredAt: NOW,
      },
      pricing: { monthlyPlanningEstimateUsd: 56.94 },
      atlas: {
        configured: true,
        available: true,
        measuredAt: NOW,
        projectId: "SECRET_PROJECT",
        cluster: {
          tier: "M10",
          clusterName: "SECRET_CLUSTER",
          diskUsedBytes: 6_000,
          diskCapacityBytes: 10_000,
          provisionedDiskGb: 10,
          diskMeasuredAt: NOW,
          autoExpandStorage: true,
          performance: {
            scope: "cluster_electable_processes_worst_case",
            processCount: 3,
            expectedProcessCount: 3,
            complete: true,
            windowMinutes: 60,
            sustainedWindowMinutes: 15,
            measuredAt: NOW,
            cpu: percentStats(30, 99, 35, 40),
            // A full WiredTiger cache is useful and must not independently
            // produce purchase advice.
            cache: percentStats(97, 100, 99, 99),
            connections: { average: 20, peak: 40, latest: 25, sampleCount: 12 },
          },
        },
        billing: {
          available: true,
          projectedMonthlyRunRateUsd: 60,
          postedCycleCents: 2_000,
          postedThrough: "2026-08-10T00:00:00.000Z",
          rawSku: "SECRET_SKU",
        },
        credential: {
          expiresAt: "2028-01-01T00:00:00.000Z",
          daysRemaining: 500,
        },
      },
    },
    render: {
      configured: true,
      available: true,
      stale: false,
      measuredAt: NOW,
      serviceId: "SECRET_SERVICE",
      service: {
        plan: "starter",
        configuredInstanceCount: 1,
        suspended: false,
        autoscalingEnabled: false,
      },
      metrics: {
        available: true,
        windowMinutes: 60,
        sustainedWindowMinutes: 15,
        resolutionSeconds: 300,
        measuredAt: NOW,
        cpu: percentStats(25, 99, 30, 40),
        memory: percentStats(40, 99, 45, 50),
      },
      cost: { monthlyPlanningUsd: 7 },
    },
  };
}

function percentStats(average, peak, latest, recent) {
  return {
    averagePercent: average,
    peakPercent: peak,
    latestPercent: latest,
    recentAveragePercent: recent,
    recentSampleCount: 3,
    sampleCount: 12,
  };
}

describe("authenticated infrastructure advisories", () => {
  test("shows real provider cost/capacity fields through a strict allowlist", () => {
    const result = buildInfrastructureAdminSnapshot(healthyInput());
    expect(result.overallStatus).toBe("healthy");
    expect(result.advisories).toEqual([]);
    expect(result.providers.cloudflare).toMatchObject({
      status: "healthy",
      usage: {
        verifiedOriginalReplays: 100,
        storedBytes: 1_000_000,
        objectCount: 250,
      },
      cost: {
        scope: "configured_bucket",
        estimatedCurrentMonthlyUsd: 0,
      },
    });
    expect(result.providers.mongo.cluster).toMatchObject({
      tier: "m10",
      diskUtilizationPercent: 60,
      performance: {
        scope: "cluster_electable_processes_worst_case",
        processCount: 3,
      },
    });
    expect(result.providers.render).toMatchObject({
      status: "healthy",
      service: { plan: "starter", instanceCount: 1 },
      cost: { monthlyPlanningUsd: 7, basis: "operator_configured" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET_ACCOUNT|SECRET_BUCKET|SECRET_PROJECT|SECRET_CLUSTER|SECRET_SKU|SECRET_SERVICE/,
    );
  });

  test("does not turn one metric peak or a full Mongo cache into upgrade advice", () => {
    const input = healthyInput();
    input.render.metrics.cpu.peakPercent = 100;
    input.mongo.atlas.cluster.performance.cpu.peakPercent = 100;
    input.mongo.atlas.cluster.performance.cache.peakPercent = 100;
    const result = buildInfrastructureAdminSnapshot(input);
    expect(result.overallStatus).toBe("healthy");
    expect(result.advisories).toEqual([]);
  });

  test("keeps Mongo storage action separate from a Render tier upgrade", () => {
    const input = healthyInput();
    input.render.metrics.cpu.recentAveragePercent = 82;
    input.mongo.atlas.cluster.diskUsedBytes = 8_600;
    const result = buildInfrastructureAdminSnapshot(input);
    expect(result.overallStatus).toBe("upgrade");
    expect(result.providers.render.status).toBe("upgrade");
    expect(result.providers.mongo.status).toBe("watch");
    expect(result.advisories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "render_cpu_utilization_upgrade",
        metric: "cpu_sustained_percent",
        value: 82,
        threshold: 80,
      }),
      expect.objectContaining({
        code: "mongo_storage_action",
        level: "watch",
        metric: "disk_utilization_percent",
        value: 86,
        threshold: 80,
      }),
    ]));
  });

  test("never recommends a purchase from stale last-good capacity metrics", () => {
    const input = healthyInput();
    input.render.stale = true;
    input.render.metrics.cpu.recentAveragePercent = 95;
    input.mongo.stale = true;
    input.mongo.atlas.cluster.performance.cpu.recentAveragePercent = 95;
    input.mongo.atlas.cluster.diskUsedBytes = 9_000;

    const result = buildInfrastructureAdminSnapshot(input);

    expect(result.overallStatus).toBe("watch");
    expect(result.providers.render).toMatchObject({
      stale: true,
      status: "watch",
    });
    expect(result.providers.mongo).toMatchObject({
      stale: true,
      status: "watch",
    });
    expect(result.advisories.map((row) => row.code)).toEqual([
      "atlas_metrics_stale",
      "render_metrics_stale",
    ]);
    expect(result.advisories).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "upgrade" }),
    ]));
  });

  test("warns when Atlas host metrics cover only part of the cluster", () => {
    const input = healthyInput();
    input.mongo.atlas.cluster.performance.processCount = 2;
    input.mongo.atlas.cluster.performance.expectedProcessCount = 3;
    input.mongo.atlas.cluster.performance.complete = false;

    const result = buildInfrastructureAdminSnapshot(input);

    expect(result.providers.mongo).toMatchObject({
      status: "watch",
      cluster: {
        performance: {
          processCount: 2,
          expectedProcessCount: 3,
          complete: false,
        },
      },
    });
    expect(result.advisories).toContainEqual(expect.objectContaining({
      level: "watch",
      code: "atlas_process_coverage_incomplete",
      metric: "measured_process_count",
      value: 2,
      threshold: 3,
    }));
  });

  test("does not report healthy when Atlas returns config without capacity signals", () => {
    const input = healthyInput();
    input.mongo.atlas.cluster.diskUsedBytes = null;
    input.mongo.atlas.cluster.diskCapacityBytes = null;
    input.mongo.atlas.cluster.performance = {
      scope: "cluster_electable_processes_worst_case",
      processCount: 3,
      expectedProcessCount: 3,
      complete: true,
      connections: { average: 20, peak: 30, latest: 25, sampleCount: 12 },
    };

    const result = buildInfrastructureAdminSnapshot(input);

    expect(result.providers.mongo.status).toBe("watch");
    expect(result.advisories.map((row) => row.code)).toEqual([
      "atlas_cpu_metrics_unavailable",
      "atlas_disk_metrics_unavailable",
    ]);
  });

  test("keeps absent provider counts and byte values unknown instead of zero", () => {
    const input = healthyInput();
    delete input.cloudflare.snapshot.archive.verifiedOriginalReplays;
    input.cloudflare.snapshot.archive.r2StoredBytes = null;
    input.cloudflare.snapshot.archive.r2ObjectCount = "";
    input.mongo.appData.logicalDataBytes = undefined;
    input.render.service.configuredInstanceCount = null;

    const result = buildInfrastructureAdminSnapshot(input);

    expect(result.providers.cloudflare.usage).toMatchObject({
      verifiedOriginalReplays: null,
      storedBytes: null,
      objectCount: null,
    });
    expect(result.providers.mongo.appData.logicalDataBytes).toBeNull();
    expect(result.providers.render.service.instanceCount).toBeNull();
  });

  test("treats missing monitoring as an in-admin setup advisory", () => {
    const result = buildInfrastructureAdminSnapshot({
      asOf: NOW,
      cloudflare: { status: { configured: false }, snapshot: null },
      mongo: {
        appData: { measuredAt: NOW },
        atlas: { configured: false },
        pricing: { monthlyPlanningEstimateUsd: 56.94 },
      },
      render: { configured: false, available: false },
    });
    expect(result.overallStatus).toBe("watch");
    expect(result.advisories.map((row) => row.code)).toEqual([
      "cloudflare_monitoring_not_configured",
      "atlas_monitoring_not_configured",
      "render_monitoring_not_configured",
    ]);
  });
});

/**
 * A Flex cluster as AtlasInfrastructureClient reports it: no disk or host
 * metrics. `allDatabases` is the cluster-wide dbStats total (null when it
 * could not be read).
 */
function flexInput(logicalDataBytes, allocatedIndexBytes, allDatabases = null) {
  const input = healthyInput();
  input.mongo.appData.logicalDataBytes = logicalDataBytes;
  input.mongo.appData.allocatedIndexBytes = allocatedIndexBytes;
  input.mongo.appData.allDatabases = allDatabases;
  input.mongo.pricing.monthlyPlanningEstimateUsd = 8;
  input.mongo.atlas.cluster = {
    tier: "FLEX",
    clusterName: "SECRET_CLUSTER",
    provisionedDiskGb: 5,
    diskUsedBytes: null,
    diskCapacityBytes: null,
    diskMeasuredAt: null,
    autoExpandStorage: false,
    performance: null,
  };
  input.mongo.atlas.billing.projectedMonthlyRunRateUsd = 9.3;
  return input;
}

describe("Atlas Flex advisories", () => {
  /** @param {number} logical @param {number} indexes */
  const cluster = (logical, indexes, databaseCount = 8) => ({
    logicalDataBytes: logical, indexBytes: indexes, databaseCount, measuredAt: "2026-11-23T23:00:00.000Z",
  });

  test("does not flag Flex's missing host metrics and measures the whole cluster's allowance", () => {
    const result = buildInfrastructureAdminSnapshot(
      flexInput(2_130_000_000, 117_000_000, cluster(2_530_000_000, 147_000_000)),
    );
    expect(result.advisories).toEqual([]);
    expect(result.providers.mongo.status).toBe("healthy");
    expect(result.providers.mongo.cluster).toMatchObject({
      tier: "flex",
      flexStorage: {
        usedBytes: 2_677_000_000,
        limitBytes: 5_000_000_000,
        utilizationPercent: 53.5,
        scope: "all_databases",
        databaseCount: 8,
      },
    });
    expect(result.providers.mongo.appData.allDatabases).toEqual(cluster(2_530_000_000, 147_000_000));
    expect(result.providers.mongo.cost).toMatchObject({
      pricingMode: "atlas_projected",
      projectedMonthlyUsd: 9.3,
      planningMonthlyUsd: 8,
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_CLUSTER|SECRET_SKU|SECRET_PROJECT/);
  });

  test("warns before the Flex data allowance and escalates near the limit", () => {
    const watch = buildInfrastructureAdminSnapshot(
      flexInput(2_130_000_000, 117_000_000, cluster(3_400_000_000, 200_000_000)),
    );
    expect(watch.advisories.map((row) => [row.code, row.level, row.value])).toEqual([
      ["mongo_flex_storage_watch", "watch", 72],
    ]);
    expect(watch.advisories[0].message).toMatch(/cluster's 8 databases use 72%/);
    const action = buildInfrastructureAdminSnapshot(
      flexInput(2_130_000_000, 117_000_000, cluster(3_900_000_000, 250_000_000)),
    );
    expect(action.advisories.map((row) => [row.code, row.level, row.value])).toEqual([
      ["mongo_flex_storage_action", "upgrade", 83],
    ]);
    expect(action.overallStatus).toBe("upgrade");
  });

  test("other databases push the cluster over the watch line while SC2 Tools alone is under it", () => {
    // SC2 Tools is 45% on its own; the cluster as a whole is 75%.
    const result = buildInfrastructureAdminSnapshot(
      flexInput(2_130_000_000, 117_000_000, cluster(3_600_000_000, 150_000_000)),
    );
    expect(result.advisories.map((row) => [row.code, row.value])).toEqual([
      ["mongo_flex_storage_watch", 75],
    ]);
  });

  test("labels an app-only figure as a lower bound when the cluster total is unreadable", () => {
    const partial = buildInfrastructureAdminSnapshot(flexInput(2_130_000_000, 117_000_000));
    expect(partial.providers.mongo.cluster.flexStorage).toMatchObject({
      utilizationPercent: 44.9,
      scope: "sc2tools_database_only",
      databaseCount: null,
    });
    expect(partial.advisories.map((row) => [row.code, row.level])).toEqual([
      ["mongo_flex_storage_partial", "watch"],
    ]);
    // A breach measured on the lower bound is still reported.
    const breach = buildInfrastructureAdminSnapshot(flexInput(3_400_000_000, 200_000_000));
    expect(breach.advisories.map((row) => row.code)).toEqual([
      "mongo_flex_storage_partial",
      "mongo_flex_storage_watch",
    ]);
    expect(breach.advisories[1].message).toMatch(/SC2 Tools database alone uses 72%/);
  });

  test("ignores a malformed cluster-wide total", () => {
    const result = buildInfrastructureAdminSnapshot(
      flexInput(2_130_000_000, 117_000_000, { logicalDataBytes: 5, indexBytes: null, databaseCount: 2 }),
    );
    expect(result.providers.mongo.appData.allDatabases).toBeNull();
    expect(result.providers.mongo.cluster.flexStorage.scope).toBe("sc2tools_database_only");
  });

  test("keeps Flex storage unknown when the app database size is unavailable", () => {
    const input = flexInput(undefined, 117_000_000);
    const result = buildInfrastructureAdminSnapshot(input);
    expect(result.providers.mongo.cluster.flexStorage).toMatchObject({
      usedBytes: null,
      utilizationPercent: null,
    });
    expect(result.advisories).toEqual([]);
  });

  test("dedicated clusters carry no Flex storage block", () => {
    const result = buildInfrastructureAdminSnapshot(healthyInput());
    expect(result.providers.mongo.cluster.flexStorage).toBeNull();
  });
});
