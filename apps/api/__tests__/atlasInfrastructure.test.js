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
      if (url.includes("/flexClusters/")) {
        return response({ errorCode: "FLEX_CLUSTER_NOT_FOUND" }, 404);
      }
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

  test("reads a Flex cluster from the Flex resource and projects from its first billed day", async () => {
    const accepts = new Map();
    const fetchImpl = jest.fn(async (url, init) => {
      if (url.endsWith("/api/oauth/token")) {
        return response({ access_token: "bearer-secret", expires_in: 3600 });
      }
      if (url.includes("/clusters/") || url.includes("/processes")) {
        throw new Error(`classic API called for a Flex cluster: ${url}`);
      }
      accepts.set(url.includes("/flexClusters/") ? "flex" : "invoice", init.headers.accept);
      if (url.endsWith(`/groups/${PROJECT_ID}/flexClusters/sample-cluster`)) {
        return response(flexClusterBody());
      }
      if (url.includes("/invoices/pending")) return response(flexInvoiceBody(30));
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new AtlasInfrastructureClient({
      config: atlasConfig(),
      fetchImpl,
      now: () => NOW,
    });
    const result = await client.snapshot();
    expect(result.cluster).toEqual({
      tier: "FLEX",
      provider: "AWS",
      region: "US_WEST_2",
      provisionedDiskGb: 5,
      autoExpandStorage: false,
      diskUsedBytes: null,
      diskCapacityBytes: null,
      diskMeasuredAt: null,
      performance: null,
    });
    // Two posted days at 30 cents: $0.60 over 2 of 31 days is ~$9.30/month,
    // not the $1.69 a whole-cycle projection would claim.
    expect(result.billing).toMatchObject({
      available: true,
      postedCycleCents: 60,
      categoryCents: { compute: 60, storage: 0, transfer: 0, other: 0 },
      projectedMonthlyRunRateCents: 930,
      projectedMonthlyRunRateUsd: 9.3,
    });
    expect(accepts.get("flex")).toBe("application/vnd.atlas.2024-11-13+json");
    expect(accepts.get("invoice")).toBe("application/vnd.atlas.2025-03-12+json");

    // The kind is cached: a second refresh probes nothing new.
    const probesBefore = fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/")).length;
    await client.snapshot();
    const probesAfter = fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/")).length;
    expect(probesAfter - probesBefore).toBe(1);
  });

  test("caps a Flex run-rate projection at the $30 monthly price cap", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith("/api/oauth/token")) {
        return response({ access_token: "bearer-secret", expires_in: 3600 });
      }
      if (url.includes("/flexClusters/")) return response(flexClusterBody());
      if (url.includes("/invoices/pending")) return response(flexInvoiceBody(150));
      throw new Error(`unexpected URL ${url}`);
    });
    const result = await new AtlasInfrastructureClient({
      config: atlasConfig(),
      fetchImpl,
      now: () => NOW,
    }).snapshot();
    expect(result.billing).toMatchObject({
      postedCycleCents: 300,
      projectedMonthlyRunRateCents: 3_000,
      projectedMonthlyRunRateUsd: 30,
    });
  });

  test("an Atlas outage during detection leaves the cluster unavailable instead of guessing a tier", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith("/api/oauth/token")) {
        return response({ access_token: "bearer-secret", expires_in: 3600 });
      }
      if (url.includes("/flexClusters/")) return response({}, 500);
      if (url.includes("/invoices/pending")) return response(invoiceBody());
      throw new Error(`unexpected URL ${url}`);
    });
    const result = await new AtlasInfrastructureClient({
      config: atlasConfig(),
      fetchImpl,
      now: () => NOW,
    }).snapshot();
    expect(result.cluster).toBeNull();
    expect(result.configErrorCode).toBe("atlas_cluster_unavailable");
    expect(result.billing.available).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("/clusters/"))).toBe(false);
  });
});

describe("Atlas Flex billing helpers", () => {
  test("measures a mid-cycle cluster from its first line item", () => {
    expect(_internals.projectCycleCost({
      postedCycleCents: 900,
      cycleStart: "2026-08-01T00:00:00.000Z",
      cycleEnd: "2026-08-31T00:00:00.000Z",
      postedThrough: "2026-08-11T00:00:00.000Z",
      billedSince: "2026-08-08T00:00:00.000Z",
    })).toBe(9_000);
    // A billedSince before the cycle (or missing) keeps the cycle start.
    expect(_internals.projectCycleCost({
      postedCycleCents: 900,
      cycleStart: "2026-08-01T00:00:00.000Z",
      cycleEnd: "2026-08-31T00:00:00.000Z",
      postedThrough: "2026-08-11T00:00:00.000Z",
      billedSince: "2026-07-20T00:00:00.000Z",
    })).toBe(2_700);
    // Less than one billed day is too little evidence for a run rate.
    expect(_internals.projectCycleCost({
      postedCycleCents: 30,
      cycleStart: "2026-08-01T00:00:00.000Z",
      cycleEnd: "2026-08-31T00:00:00.000Z",
      postedThrough: "2026-08-11T00:00:00.000Z",
      billedSince: "2026-08-10T12:00:00.000Z",
    })).toBeNull();
  });

  test("files Flex charges as the cluster's compute", () => {
    expect(_internals.atlasCostCategory("ATLAS_AWS_FLEX_INSTANCE_100")).toBe("compute");
    expect(_internals.atlasCostCategory("FLEX_CLUSTER_OPS_BAND_2")).toBe("compute");
  });

  test("keeps a Flex run rate inside the tier's $8-$30 price range", () => {
    const clamp = _internals.clampFlexProjection;
    expect(clamp(812, { discounted: false })).toBe(812);
    expect(clamp(558, { discounted: false })).toBe(800);
    expect(clamp(4_650, { discounted: false })).toBe(3_000);
    // Credits can bring the real charge under $8, so no floor then.
    expect(clamp(558, { discounted: true })).toBe(558);
    expect(clamp(4_650, { discounted: true })).toBe(3_000);
    expect(clamp(null, { discounted: false })).toBeNull();
  });

  test("bills through the newest line item, not the invoice's last update", () => {
    const through = _internals.billedThrough;
    expect(through(["2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z"], ["2026-08-11T03:00:00.000Z"]))
      .toBe("2026-08-11T00:00:00.000Z");
    // A line that claims to end after the invoice was last updated is capped.
    expect(through(["2026-08-31T00:00:00.000Z"], ["2026-08-11T03:00:00.000Z"]))
      .toBe("2026-08-11T03:00:00.000Z");
    expect(through([], ["2026-08-11T03:00:00.000Z"])).toBe("2026-08-11T03:00:00.000Z");
    expect(through(["2026-08-11T00:00:00.000Z"], [])).toBe("2026-08-11T00:00:00.000Z");
    expect(through([], [])).toBeNull();
  });

  test("an invoice updated hours after the last billed hour does not dilute the run rate", () => {
    const body = flexInvoiceBody(30);
    body.updated = "2026-08-11T03:00:00.000Z";
    expect(_internals.parsePendingInvoices(body, {
      projectId: PROJECT_ID,
      clusterName: "sample-cluster",
    })).toMatchObject({
      postedThrough: "2026-08-11T00:00:00.000Z",
      projectedMonthlyRunRateCents: 930,
    });
  });

  test("a partly billed first Flex day cannot pull the run rate under the $8 base band", () => {
    const body = flexInvoiceBody(26);
    // The cutover-day line starts at midnight but bills only the evening.
    body.lineItems[0].totalPriceCents = 10;
    const target = { projectId: PROJECT_ID, clusterName: "sample-cluster" };
    expect(_internals.parsePendingInvoices(body, target)).toMatchObject({
      postedCycleCents: 36,
      projectedMonthlyRunRateCents: 800,
      projectedMonthlyRunRateUsd: 8,
    });
    // With credits posted, the honest projection is kept.
    body.lineItems[1].discountCents = 6;
    expect(_internals.parsePendingInvoices(body, target)).toMatchObject({
      postedCycleCents: 30,
      projectedMonthlyRunRateCents: 465,
    });
    // A dedicated cluster's projection is never clamped.
    const dedicated = flexInvoiceBody(10);
    for (const item of dedicated.lineItems) item.sku = "GCP_INSTANCE_M10";
    expect(_internals.parsePendingInvoices(dedicated, target).projectedMonthlyRunRateCents).toBe(310);
    // Unless the tier is known to be Flex from the cluster probe.
    expect(_internals.parsePendingInvoices(dedicated, target, { flex: true })
      .projectedMonthlyRunRateCents).toBe(800);
  });
});

describe("Atlas cluster kind detection", () => {
  function token(url) {
    return url.endsWith("/api/oauth/token")
      ? response({ access_token: "bearer-secret", expires_in: 3600 })
      : null;
  }

  test("reuses the probe's Flex response for the cluster read", async () => {
    const fetchImpl = jest.fn(async (url) => token(url)
      ?? (url.includes("/flexClusters/") ? response(flexClusterBody())
        : url.includes("/invoices/pending") ? response(flexInvoiceBody(30))
          : Promise.reject(new Error(`unexpected URL ${url}`))));
    const result = await new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => NOW }).snapshot();
    expect(result.cluster.tier).toBe("FLEX");
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/"))).toHaveLength(1);
  });

  test("applies the Flex price range from Flex line items even when the cluster read fails", async () => {
    const fetchImpl = jest.fn(async (url) => token(url)
      ?? (url.includes("/flexClusters/") ? response({}, 503)
        : url.includes("/invoices/pending") ? response(flexInvoiceBody(150))
          : Promise.reject(new Error(`unexpected URL ${url}`))));
    const result = await new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => NOW }).snapshot();
    expect(result.cluster).toBeNull();
    expect(result.billing).toMatchObject({ postedCycleCents: 300, projectedMonthlyRunRateCents: 3_000 });
  });

  test("keeps the last known kind through a transient probe failure", async () => {
    let now = NOW;
    let probeStatus = 404;
    const fetchImpl = jest.fn(async (url) => {
      const auth = token(url);
      if (auth) return auth;
      if (url.includes("/flexClusters/")) return response({}, probeStatus);
      if (url.includes("/backup/snapshots")) return response({ results: [] });
      if (url.includes("/backup/schedule")) return response({});
      if (url.includes("/clusters/sample-cluster")) return response(clusterBody());
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => now });
    await expect(client.backupStatus()).resolves.toMatchObject({ cloudBackupEnabled: null });
    // Past the cache window the probe fails with a 503: the cluster is still
    // read as dedicated instead of failing the backup check.
    now = new Date(NOW.getTime() + 7 * 60 * 60 * 1000);
    probeStatus = 503;
    await expect(client.backupStatus()).resolves.toMatchObject({ pointInTime: { enabled: null } });
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/"))).toHaveLength(2);
  });

  test("with no kind learned yet, a probe outage still fails instead of guessing", async () => {
    const fetchImpl = jest.fn(async (url) => token(url) ?? response({}, 503));
    await expect(new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => NOW })
      .backupStatus()).rejects.toMatchObject({ code: "atlas_admin_http_503" });
  });
});

function flexClusterBody() {
  return {
    name: "sample-cluster",
    clusterType: "REPLICASET",
    mongoDBVersion: "8.0.39",
    stateName: "IDLE",
    providerSettings: {
      backingProviderName: "AWS",
      providerName: "FLEX",
      regionName: "US_WEST_2",
      diskSizeGB: 5,
    },
    backupSettings: { enabled: true },
    connectionStrings: { standardSrv: "mongodb+srv://sample-cluster.abcde.mongodb.net" },
  };
}

/** Two posted Flex days (Aug 9 and Aug 10) at `dailyCents` each. */
function flexInvoiceBody(dailyCents) {
  return {
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-09-01T00:00:00.000Z",
    updated: "2026-08-11T00:00:00.000Z",
    lineItems: [
      line("ATLAS_AWS_FLEX_INSTANCE_100", dailyCents, {
        startDate: "2026-08-09T00:00:00.000Z",
        endDate: "2026-08-10T00:00:00.000Z",
      }),
      line("ATLAS_AWS_FLEX_INSTANCE_100", dailyCents, {
        startDate: "2026-08-10T00:00:00.000Z",
        endDate: "2026-08-11T00:00:00.000Z",
      }),
      line("GCP_INSTANCE_M10", 1_970, {
        clusterName: "old-dedicated-cluster",
        startDate: "2026-08-01T00:00:00.000Z",
        endDate: "2026-08-09T00:00:00.000Z",
      }),
    ],
  };
}

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
