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

  test("keeps a Flex run rate inside the tier's price range for the cycle", () => {
    const august = { cycleStart: "2026-08-01T00:00:00.000Z", cycleEnd: "2026-09-01T00:00:00.000Z" };
    const run = (projected, extra = {}) => _internals.flexRunRate({
      projected, postedCycleCents: 60, grossCents: 60, discountCents: 0, ...august, ...extra,
    });
    expect(run(900)).toEqual({ cents: 900, basis: "posted" });
    // 744 hours at the base band's 1.1 cents.
    expect(run(558)).toEqual({ cents: 818, basis: "flex_base_price" });
    expect(run(4_650)).toEqual({ cents: 3_000, basis: "flex_cap" });
    // A 28-day February's base band is $7.39, not $8.
    expect(run(700, { cycleStart: "2027-02-01T00:00:00.000Z", cycleEnd: "2027-03-01T00:00:00.000Z" }))
      .toEqual({ cents: 739, basis: "flex_base_price" });
    // Discounts scale the floor instead of removing it.
    expect(run(465, { postedCycleCents: 30, grossCents: 36, discountCents: 6 }))
      .toEqual({ cents: 682, basis: "flex_base_price" });
    // Nothing billed at list price: no floor to invent.
    expect(run(0, { postedCycleCents: 0, grossCents: 0 })).toEqual({ cents: 0, basis: "posted" });
    // Never below what has already posted.
    expect(run(4_800, { postedCycleCents: 3_100, grossCents: 3_100 }))
      .toEqual({ cents: 3_100, basis: "posted" });
    expect(run(null)).toEqual({ cents: null, basis: null });
    // A stray early line date cannot stretch the floor past a 31-day month.
    expect(run(100, { cycleStart: "2026-06-15T00:00:00.000Z" }))
      .toEqual({ cents: 818, basis: "flex_base_price" });
    // Credits posted as negative lines: no floor to hold, so no base-price label.
    expect(run(-50, { postedCycleCents: -50, grossCents: -50 }))
      .toEqual({ cents: -50, basis: "posted" });
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

  test("a partly billed first Flex day cannot pull the run rate under the base band", () => {
    const body = flexInvoiceBody(26);
    // The cutover-day line starts at midnight but bills only the evening.
    body.lineItems[0].totalPriceCents = 10;
    const target = { projectId: PROJECT_ID, clusterName: "sample-cluster" };
    expect(_internals.parsePendingInvoices(body, target)).toMatchObject({
      postedCycleCents: 36,
      projectedMonthlyRunRateCents: 818,
      projectedMonthlyRunRateUsd: 8.18,
      projectionBasis: "flex_base_price",
    });
    // A line discount scales the floor rather than dropping it.
    body.lineItems[1].discountCents = 6;
    expect(_internals.parsePendingInvoices(body, target)).toMatchObject({
      postedCycleCents: 30,
      projectedMonthlyRunRateCents: 682,
    });
  });

  test("a definite tier from the probe decides; Flex SKUs only fill in an unknown tier", () => {
    const target = { projectId: PROJECT_ID, clusterName: "sample-cluster" };
    const dedicated = flexInvoiceBody(10);
    for (const item of dedicated.lineItems) item.sku = "GCP_INSTANCE_M10";
    expect(_internals.parsePendingInvoices(dedicated, target)).toMatchObject({
      projectedMonthlyRunRateCents: 310,
      projectionBasis: "posted",
    });
    expect(_internals.parsePendingInvoices(dedicated, target, { kind: "flex" })
      .projectedMonthlyRunRateCents).toBe(818);
    // The probe says dedicated: Flex SKUs do not clamp it.
    const flexDays = flexInvoiceBody(26);
    flexDays.lineItems[0].totalPriceCents = 10;
    expect(_internals.parsePendingInvoices(flexDays, target, { kind: "dedicated" })
      .projectedMonthlyRunRateCents).toBe(558);
  });

  test("a cluster upgraded in place from Flex is never clamped below what has posted", () => {
    // Flex on Aug 1-2, then an M10 under the same name from Aug 3.
    const body = {
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-09-01T00:00:00.000Z",
      updated: "2026-08-26T05:00:00.000Z",
      lineItems: [
        line("ATLAS_FLEX_AWS_100_USAGE_HOURS", 60, {
          startDate: "2026-08-01T00:00:00.000Z", endDate: "2026-08-03T00:00:00.000Z",
        }),
        line("ATLAS_AWS_INSTANCE_M10", 4_180, {
          startDate: "2026-08-03T00:00:00.000Z", endDate: "2026-08-26T00:00:00.000Z",
        }),
      ],
    };
    const target = { projectId: PROJECT_ID, clusterName: "sample-cluster" };
    for (const kind of ["dedicated", null]) {
      const billing = _internals.parsePendingInvoices(body, target, { kind });
      expect(billing.postedCycleCents).toBe(4_240);
      // 4240 cents over 25 of 31 days, unclamped.
      expect(billing.projectedMonthlyRunRateCents).toBe(5_258);
      expect(billing.projectionBasis).toBe("posted");
    }
  });

  test("totals other clusters' charges in the project for admins", () => {
    const target = { projectId: PROJECT_ID, clusterName: "sample-cluster" };
    // flexInvoiceBody carries 1970 cents for "old-dedicated-cluster",
    // billed through Aug 9.
    expect(_internals.parsePendingInvoices(flexInvoiceBody(30), target)).toMatchObject({
      otherClustersPostedCents: 1_970,
      otherClustersBilledThrough: "2026-08-09T00:00:00.000Z",
    });
    // Still reported before the configured cluster's first line posts.
    const onlyOld = flexInvoiceBody(30);
    onlyOld.lineItems = onlyOld.lineItems.slice(2);
    expect(_internals.parsePendingInvoices(onlyOld, target)).toMatchObject({
      available: false,
      errorCode: "atlas_billing_no_matching_line_items",
      otherClustersPostedCents: 1_970,
    });
    // Other projects and org-level lines without a cluster never count.
    expect(_internals.parsePendingInvoices(invoiceBody(), target).otherClustersPostedCents).toBe(0);
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
    expect(result.billing).toMatchObject({
      postedCycleCents: 300,
      projectedMonthlyRunRateCents: 3_000,
      projectionBasis: "flex_cap",
    });
  });

  test("requests invoices alongside the kind probe instead of after it", async () => {
    let releaseProbe;
    const probe = new Promise((resolve) => { releaseProbe = resolve; });
    const fetchImpl = jest.fn(async (url) => token(url)
      ?? (url.includes("/flexClusters/") ? probe
        : url.includes("/invoices/pending") ? response(flexInvoiceBody(30))
          : Promise.reject(new Error(`unexpected URL ${url}`))));
    const pending = new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => NOW }).snapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("/invoices/pending"))).toBe(true);
    releaseProbe(response(flexClusterBody()));
    await expect(pending).resolves.toMatchObject({ cluster: { tier: "FLEX" } });
  });

  test("an in-place upgrade from Flex drops the cached kind on the first 400", async () => {
    let upgraded = false;
    const fetchImpl = jest.fn(async (url) => {
      const auth = token(url);
      if (auth) return auth;
      if (url.includes("/flexClusters/")) return upgraded ? response({ errorCode: "CANNOT_USE_CLUSTER_IN_FLEX_CLUSTER_API" }, 400) : response(flexClusterBody());
      if (url.includes("/invoices/pending")) return response(flexInvoiceBody(30));
      if (url.includes("/processes")) return response({ results: [] });
      if (url.includes("/clusters/sample-cluster")) return response(clusterBody());
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => NOW });
    expect((await client.snapshot()).cluster.tier).toBe("FLEX");
    upgraded = true;
    // Still inside the cache window: the Flex read fails once...
    expect((await client.snapshot()).cluster).toBeNull();
    // ...and the next refresh probes again and reads the new tier.
    const after = await client.snapshot();
    expect(after.cluster.tier).toBe("M10");
    expect(after.billing.projectionBasis).toBe("posted");
  });

  test("a stale Flex kind does not re-request the resource the probe just failed on", async () => {
    let now = NOW;
    let flexStatus = 200;
    const fetchImpl = jest.fn(async (url) => token(url)
      ?? (url.includes("/flexClusters/") ? (flexStatus === 200 ? response(flexClusterBody()) : response({}, flexStatus))
        : url.includes("/invoices/pending") ? response(flexInvoiceBody(30))
          : Promise.reject(new Error(`unexpected URL ${url}`))));
    const client = new AtlasInfrastructureClient({ config: atlasConfig(), fetchImpl, now: () => now });
    await client.snapshot();
    now = new Date(NOW.getTime() + 7 * 60 * 60 * 1000);
    flexStatus = 503;
    const before = fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/")).length;
    const result = await client.snapshot();
    expect(result.cluster).toBeNull();
    // Billing still knows the cluster is Flex.
    expect(result.billing.projectedMonthlyRunRateCents).toBe(930);
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/flexClusters/")).length - before).toBe(1);
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
    // During the outage the stale kind is reused for a few minutes rather
    // than probing on every call.
    now = new Date(now.getTime() + 60 * 1000);
    await client.backupStatus();
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
