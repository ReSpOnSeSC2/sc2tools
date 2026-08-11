// @ts-nocheck
"use strict";

const {
  AtlasInfrastructureClient,
  _internals,
} = require("../src/services/atlasInfrastructure");

const NOW = new Date("2026-08-11T17:30:00.000Z");
const PROJECT_ID = "89abcdef0123456701234567";
const ORG_ID = "0123456789abcdef01234567";

function atlasConfig() {
  return {
    clientId: "service-account-id",
    clientSecret: "service-account-secret",
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    clusterName: "sample-cluster",
  };
}

function clusterBody() {
  return {
    name: "sample-cluster",
    connectionStrings: {
      standard: "mongodb://node-a.example.net:27017,node-b.example.net:27017",
    },
    replicationSpecs: [{
      regionConfigs: [{
        providerName: "GCP",
        regionName: "WESTERN_US",
        electableSpecs: { instanceSize: "M10", diskSizeGB: 10 },
        autoScaling: { diskGB: { enabled: true } },
      }],
    }],
  };
}

function invoiceBody() {
  return {
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-09-01T00:00:00.000Z",
    updated: "2026-08-11T00:00:00.000Z",
    lineItems: [
      line("GCP_INSTANCE_M10", 1_970),
      line("DATA_TRANSFER_INTERNET", 590),
      line("PIT_RESTORE_STORAGE", 251),
      line("DATA_TRANSFER_INTER_ZONE", 31),
      line("BACKUP_SNAPSHOT_STORAGE", 17),
      line("UNRELATED", 999, { groupId: "ffffffffffffffffffffffff" }),
    ],
  };
}

function line(sku, totalPriceCents, overrides = {}) {
  return {
    clusterName: "sample-cluster",
    groupId: PROJECT_ID,
    sku,
    totalPriceCents,
    discountCents: 0,
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Atlas infrastructure parsing", () => {
  test("parses the current single pending-invoice shape and projects its cycle", () => {
    expect(_internals.parsePendingInvoices(invoiceBody(), {
      projectId: PROJECT_ID,
      clusterName: "sample-cluster",
    })).toMatchObject({
      available: true,
      cycleStart: "2026-08-01T00:00:00.000Z",
      cycleEnd: "2026-09-01T00:00:00.000Z",
      postedThrough: "2026-08-11T00:00:00.000Z",
      postedCycleCents: 2_859,
      categoryCents: {
        compute: 1_970,
        storage: 268,
        transfer: 621,
        other: 0,
      },
      projectedMonthlyRunRateCents: 8_863,
      projectedMonthlyRunRateUsd: 88.63,
      lineItemCount: 5,
    });
  });

  test("requires at least one elapsed day before projecting", () => {
    expect(_internals.projectCycleCost({
      postedCycleCents: 50,
      cycleStart: "2026-08-01T00:00:00.000Z",
      cycleEnd: "2026-09-01T00:00:00.000Z",
      postedThrough: "2026-08-01T12:00:00.000Z",
    })).toBeNull();
  });

  test("does not treat zero matching invoice lines as a real $0 run rate", () => {
    expect(_internals.parsePendingInvoices({
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-09-01T00:00:00.000Z",
      updated: "2026-08-11T00:00:00.000Z",
      lineItems: [line("GCP_INSTANCE_M10", 1_970, {
        groupId: "ffffffffffffffffffffffff",
        clusterName: "another-cluster",
      })],
    }, {
      projectId: PROJECT_ID,
      clusterName: "sample-cluster",
    })).toMatchObject({
      available: false,
      projectedMonthlyRunRateCents: null,
      projectedMonthlyRunRateUsd: null,
      lineItemCount: 0,
      errorCode: "atlas_billing_no_matching_line_items",
    });
  });

  test("rounds fractional Atlas BYTES metrics for stable JSON", () => {
    expect(_internals.parseDiskMeasurements({
      measurements: [
        metric("DISK_PARTITION_SPACE_USED", 3_954_452_070.4),
        metric("DISK_PARTITION_SPACE_FREE", 6_678_108_569.6),
      ],
    })).toEqual({
      diskUsedBytes: 3_954_452_070,
      diskCapacityBytes: 10_632_560_640,
      diskMeasuredAt: "2026-08-11T17:25:00.000Z",
    });
  });

  test("prefers effective cluster specs over requested replication specs", () => {
    expect(_internals.parseCluster({
      replicationSpecs: [{
        regionConfigs: [{
          providerName: "GCP",
          regionName: "OLD",
          electableSpecs: { instanceSize: "M10", diskSizeGB: 10 },
        }],
      }],
      effectiveReplicationSpecs: [{
        regionConfigs: [{
          providerName: "GCP",
          regionName: "CURRENT",
          electableSpecs: { instanceSize: "M20", diskSizeGB: 20 },
        }],
      }],
    })).toMatchObject({
      tier: "M20",
      region: "CURRENT",
      provisionedDiskGb: 20,
    });
  });

  test("parses sustained CPU/cache and does not cap connection counts", () => {
    const times = [
      "2026-08-11T17:15:00.000Z",
      "2026-08-11T17:20:00.000Z",
      "2026-08-11T17:25:00.000Z",
    ];
    const parsed = _internals.parseProcessMeasurements({
      measurements: [
        metricSeries("SYSTEM_NORMALIZED_CPU_USER", [40, 50, 60], times),
        metricSeries("SYSTEM_NORMALIZED_CPU_KERNEL", [10, 10, 10], times),
        metricSeries("CACHE_FILL_RATIO", [0.7, 0.8, 0.9], times),
        metricSeries("CONNECTIONS", [110, 120, 130], times),
      ],
    });
    expect(parsed).toMatchObject({
      scope: "single_electable_process",
      sustainedWindowMinutes: 15,
      cpu: {
        averagePercent: 60,
        peakPercent: 70,
        latestPercent: 70,
        recentAveragePercent: 60,
        recentSampleCount: 3,
      },
      cache: {
        averagePercent: 80,
        peakPercent: 90,
        latestPercent: 90,
      },
      connections: {
        average: 120,
        peak: 130,
        latest: 130,
      },
    });
  });

  test("ignores null and blank Atlas datapoints instead of coercing zero", () => {
    const times = [
      "2026-08-11T17:15:00.000Z",
      "2026-08-11T17:20:00.000Z",
      "2026-08-11T17:25:00.000Z",
    ];
    expect(_internals.parseProcessMeasurements({
      measurements: [
        metricSeries("SYSTEM_NORMALIZED_CPU_USER", [null, "", undefined], times),
      ],
    })).toBeNull();
  });

  test("aggregates the worst signal across every measured electable node", () => {
    const first = {
      measuredAt: "2026-08-11T17:25:00.000Z",
      cpu: percentStats(60, 80, 70, 65),
      cache: percentStats(70, 90, 85, 80),
      connections: numberStats(20, 30, 25),
    };
    const second = {
      measuredAt: "2026-08-11T17:25:00.000Z",
      cpu: percentStats(75, 95, 90, 88),
      cache: percentStats(65, 85, 75, 70),
      connections: numberStats(40, 50, 45),
    };
    expect(_internals.aggregateProcessPerformance([first, second], 3))
      .toMatchObject({
        scope: "cluster_electable_processes_worst_case",
        processCount: 2,
        expectedProcessCount: 3,
        complete: false,
        cpu: {
          averagePercent: 75,
          peakPercent: 95,
          latestPercent: 90,
          recentAveragePercent: 88,
        },
        connections: { average: 40, peak: 50, latest: 45 },
      });
  });

  test("marks process coverage incomplete when a large cluster exceeds the fan-out cap", () => {
    const hosts = Array.from({ length: 10 }, (_, index) =>
      `node-${index}.example.net:27017`);
    const cluster = {
      connectionStrings: { standard: `mongodb://${hosts.join(",")}` },
    };
    const processes = hosts.map((host, index) => ({
      id: host,
      hostname: host.replace(/:\d+$/, ""),
      typeName: index === 0 ? "REPLICA_PRIMARY" : "REPLICA_SECONDARY",
    }));

    const window = _internals.selectClusterProcessWindow(cluster, processes);

    expect(window.processes).toHaveLength(9);
    expect(window.expectedProcessCount).toBe(10);
    expect(_internals.aggregateProcessPerformance(
      window.processes.map(() => ({
        measuredAt: "2026-08-11T17:25:00.000Z",
        cpu: percentStats(20, 30, 25, 22),
      })),
      window.expectedProcessCount,
    )).toMatchObject({
      processCount: 9,
      expectedProcessCount: 10,
      complete: false,
    });
  });
});

describe("AtlasInfrastructureClient", () => {
  test("uses one OAuth token and returns an identifier-free aggregate", async () => {
    const fetchImpl = jest.fn(async (url, init) => {
      if (url.endsWith("/api/oauth/token")) {
        expect(init.headers.authorization).toBe(
          `Basic ${Buffer.from("service-account-id:service-account-secret").toString("base64")}`,
        );
        return response({ access_token: "bearer-secret", expires_in: 3600 });
      }
      expect(init.headers.authorization).toBe("Bearer bearer-secret");
      if (url.includes("/clusters/")) return response(clusterBody());
      if (url.includes("/invoices/pending")) return response(invoiceBody());
      if (url.endsWith("/processes?itemsPerPage=100")) {
        return response({
          results: [{
            id: "node-a.example.net:27017",
            hostname: "node-a.example.net",
            port: 27017,
            typeName: "REPLICA_PRIMARY",
          }],
        });
      }
      if (url.includes("/disks?") || url.endsWith("/disks?itemsPerPage=100")) {
        return response({ results: [{ partitionName: "data" }] });
      }
      if (url.includes("/disks/data/measurements?")) {
        return response({
          measurements: [
            metric("DISK_PARTITION_SPACE_USED", 3_954_452_070.4),
            metric("DISK_PARTITION_SPACE_FREE", 6_678_108_569.6),
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new AtlasInfrastructureClient({
      config: atlasConfig(),
      fetchImpl,
      now: () => NOW,
    });
    const result = await client.snapshot();

    expect(result).toMatchObject({
      available: true,
      cluster: {
        tier: "M10",
        provider: "GCP",
        region: "WESTERN_US",
        provisionedDiskGb: 10,
        diskUsedBytes: 3_954_452_070,
      },
      billing: {
        postedCycleCents: 2_859,
        projectedMonthlyRunRateCents: 8_863,
      },
    });
    expect(fetchImpl.mock.calls.filter(([url]) =>
      url.endsWith("/api/oauth/token"))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /sample-cluster|0123456789abcdef|89abcdef|bearer-secret|service-account/,
    );
  });
});

function metric(name, value) {
  return {
    name,
    units: "BYTES",
    dataPoints: [{ timestamp: "2026-08-11T17:25:00.000Z", value }],
  };
}

function metricSeries(name, values, timestamps) {
  return {
    name,
    units: name === "CACHE_FILL_RATIO" ? "SCALAR" : "PERCENT",
    dataPoints: values.map((value, index) => ({
      timestamp: timestamps[index],
      value,
    })),
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

function numberStats(average, peak, latest) {
  return { average, peak, latest, sampleCount: 12 };
}
