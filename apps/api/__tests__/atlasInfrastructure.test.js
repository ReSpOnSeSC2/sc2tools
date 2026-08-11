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
