// @ts-nocheck
"use strict";

/**
 * AtlasInfrastructureClient.backupStatus(): Cloud Backup snapshot and
 * schedule parsing against fixture JSON shaped like the Atlas Admin API v2
 * responses, the 403 path for a service account without Project Read
 * Only, and the allowlist that keeps ids, hostnames and names out.
 */

const {
  AtlasInfrastructureClient,
  _internals,
} = require("../src/services/atlasInfrastructure");
const SNAPSHOTS = require("./fixtures/atlasBackupSnapshots.json");
const SCHEDULE = require("./fixtures/atlasBackupSchedule.json");

const NOW = new Date("2026-08-11T17:30:00.000Z");
const PROJECT_ID = "89abcdef0123456701234567";

function atlasConfig() {
  return {
    clientId: "service-account-id",
    clientSecret: "service-account-secret",
    orgId: "0123456789abcdef01234567",
    projectId: PROJECT_ID,
    clusterName: "sample-cluster",
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const CLUSTER_PATH = `/api/atlas/v2/groups/${PROJECT_ID}/clusters/sample-cluster`;

/**
 * @param {{ snapshots?: object, schedule?: object, cluster?: object }} statuses
 *   HTTP status per endpoint (default 200).
 */
function atlasFetch(statuses = {}) {
  return jest.fn(async (url) => {
    if (url.endsWith("/api/oauth/token")) {
      return response({ access_token: "bearer-secret", expires_in: 3600 });
    }
    if (url.includes(`${CLUSTER_PATH}/backup/snapshots`)) {
      expect(url).toContain("itemsPerPage=500");
      return response(SNAPSHOTS, statuses.snapshots || 200);
    }
    if (url.endsWith(`${CLUSTER_PATH}/backup/schedule`)) {
      return response(SCHEDULE, statuses.schedule || 200);
    }
    if (url.endsWith(CLUSTER_PATH)) {
      return response(
        { name: "sample-cluster", backupEnabled: true, pitEnabled: true },
        statuses.cluster || 200,
      );
    }
    throw new Error(`unexpected URL ${url}`);
  });
}

function client(fetchImpl) {
  return new AtlasInfrastructureClient({
    config: atlasConfig(),
    fetchImpl,
    now: () => NOW,
  });
}

describe("Atlas backup parsing", () => {
  test("takes the newest completed snapshot and the newest snapshot's state", () => {
    expect(_internals.parseBackupSnapshots(SNAPSHOTS)).toEqual({
      lastSnapshotAt: "2026-08-11T06:03:55.000Z",
      latestStatus: "inProgress",
      completedSnapshotCount: 2,
    });
  });

  test("reports no snapshot when none has completed", () => {
    expect(_internals.parseBackupSnapshots({
      results: [{ createdAt: "2026-08-11T06:00:00Z", status: "failed" }],
    })).toEqual({
      lastSnapshotAt: null,
      latestStatus: "failed",
      completedSnapshotCount: 0,
    });
    expect(_internals.parseBackupSnapshots({})).toEqual({
      lastSnapshotAt: null,
      latestStatus: null,
      completedSnapshotCount: 0,
    });
  });

  test("maps an unrecognised snapshot state to unknown", () => {
    expect(_internals.parseBackupSnapshots({
      results: [{ createdAt: "2026-08-11T06:00:00Z", status: "<script>" }],
    }).latestStatus).toBe("unknown");
  });

  test("summarises retention by frequency and drops unknown policy items", () => {
    expect(_internals.parseBackupSchedule(SCHEDULE)).toEqual({
      nextSnapshotAt: "2026-08-11T18:04:00.000Z",
      restoreWindowDays: 2,
      retention: [
        { frequency: "hourly", everyHours: 6, keep: 2, unit: "days" },
        { frequency: "daily", everyHours: null, keep: 7, unit: "days" },
        { frequency: "weekly", everyHours: null, keep: 4, unit: "weeks" },
        { frequency: "monthly", everyHours: null, keep: 12, unit: "months" },
      ],
    });
  });

  test("treats a missing schedule as empty rather than an error", () => {
    expect(_internals.parseBackupSchedule(null)).toEqual({
      nextSnapshotAt: null,
      restoreWindowDays: null,
      retention: [],
    });
  });
});

describe("AtlasInfrastructureClient.backupStatus", () => {
  test("returns only timestamps, states and retention, never identifiers", async () => {
    const fetchImpl = atlasFetch();
    const result = await client(fetchImpl).backupStatus();

    expect(result).toEqual({
      lastSnapshotAt: "2026-08-11T06:03:55.000Z",
      latestStatus: "inProgress",
      completedSnapshotCount: 2,
      nextSnapshotAt: "2026-08-11T18:04:00.000Z",
      retention: [
        { frequency: "hourly", everyHours: 6, keep: 2, unit: "days" },
        { frequency: "daily", everyHours: null, keep: 7, unit: "days" },
        { frequency: "weekly", everyHours: null, keep: 4, unit: "weeks" },
        { frequency: "monthly", everyHours: null, keep: 12, unit: "months" },
      ],
      cloudBackupEnabled: true,
      pointInTime: { enabled: true, windowDays: 2 },
    });
    expect(fetchImpl.mock.calls.filter(([url]) =>
      url.endsWith("/api/oauth/token"))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /sample-cluster|89abcdef|66b8a0f3|atlas-abc123|bearer-secret|service-account|GCP|migration/,
    );
  });

  test("throws the Atlas HTTP code when the account can't read snapshots", async () => {
    await expect(client(atlasFetch({ snapshots: 403 })).backupStatus())
      .rejects.toMatchObject({ code: "atlas_admin_http_403" });
  });

  test("throws the OAuth code when the service-account secret is rejected", async () => {
    const fetchImpl = jest.fn(async () => response({}, 401));
    await expect(client(fetchImpl).backupStatus())
      .rejects.toMatchObject({ code: "atlas_oauth_http_401" });
  });

  test("keeps the snapshot result when the schedule and cluster reads fail", async () => {
    const result = await client(atlasFetch({ schedule: 404, cluster: 403 }))
      .backupStatus();
    expect(result).toMatchObject({
      lastSnapshotAt: "2026-08-11T06:03:55.000Z",
      nextSnapshotAt: null,
      retention: [],
      cloudBackupEnabled: null,
      pointInTime: { enabled: null, windowDays: null },
    });
  });

  test("reports no point-in-time window when continuous backup is off", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith("/api/oauth/token")) {
        return response({ access_token: "bearer-secret", expires_in: 3600 });
      }
      if (url.includes("/backup/snapshots")) return response(SNAPSHOTS);
      if (url.endsWith("/backup/schedule")) return response(SCHEDULE);
      return response({ backupEnabled: true, pitEnabled: false });
    });
    const result = await client(fetchImpl).backupStatus();
    expect(result.pointInTime).toEqual({ enabled: false, windowDays: null });
  });
});
