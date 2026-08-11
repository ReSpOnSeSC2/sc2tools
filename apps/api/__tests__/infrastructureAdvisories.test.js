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
