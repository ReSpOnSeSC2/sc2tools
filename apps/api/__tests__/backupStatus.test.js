// @ts-nocheck
"use strict";

/**
 * BackupStatusService + the hourly stale-backup job: freshness bands,
 * the ten-minute cache, fail-soft paths (no credentials, 403, outage with
 * a last-good result), in-app snapshot counts, and the once-a-day
 * ``backup_stale`` admin event.
 */

const {
  BackupStatusService,
  _internals,
} = require("../src/services/backupStatus");
const { buildBackupHealthJob } = require("../src/jobs/backupHealthJob");
const { JobLedger } = require("../src/util/jobLedger");

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-08-11T17:30:00.000Z");

function atlasError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function backup(overrides = {}) {
  return {
    lastSnapshotAt: new Date(T0.getTime() - 5 * HOUR).toISOString(),
    latestStatus: "completed",
    completedSnapshotCount: 31,
    nextSnapshotAt: new Date(T0.getTime() + HOUR).toISOString(),
    retention: [{ frequency: "daily", everyHours: null, keep: 7, unit: "days" }],
    cloudBackupEnabled: true,
    pointInTime: { enabled: true, windowDays: 2 },
    ...overrides,
  };
}

/** Fake user_backups collection: just the reads inAppCounts() makes. */
function fakeDb({ count = 0, userIds = [], newest = null, storageSize = 0, statsError = null } = {}) {
  const cursor = {
    sort: jest.fn(() => cursor),
    limit: jest.fn(() => cursor),
    maxTimeMS: jest.fn(() => cursor),
    next: jest.fn(async () => (newest ? { createdAt: newest } : null)),
  };
  const userBackups = {
    collectionName: "user_backups",
    estimatedDocumentCount: jest.fn(async () => count),
    distinct: jest.fn(async () => userIds),
    find: jest.fn(() => cursor),
  };
  return {
    userBackups,
    db: {
      command: jest.fn(async () => {
        if (statsError) throw statsError;
        return { storageSize };
      }),
    },
  };
}

function service({ atlas, now = () => T0, adminEvents = null, db = fakeDb() } = {}) {
  return new BackupStatusService({
    db,
    atlasClient: atlas === undefined ? { backupStatus: jest.fn(async () => backup()) } : atlas,
    adminEvents,
    now,
  });
}

describe("backup freshness bands", () => {
  test.each([
    [0, "fresh"],
    [25.9, "fresh"],
    [26, "aging"],
    [49.9, "aging"],
    [50, "stale"],
    [400, "stale"],
    [null, "missing"],
  ])("%s hours old is %s", (hours, freshness) => {
    expect(_internals.backupFreshness(hours)).toBe(freshness);
  });

  test("counts a snapshot timestamp in the future as zero hours old", () => {
    const future = new Date(T0.getTime() + HOUR).toISOString();
    expect(_internals.snapshotAgeHours(future, T0.getTime())).toBe(0);
    expect(_internals.snapshotAgeHours(null, T0.getTime())).toBeNull();
  });

  test.each([
    ["atlas_admin_http_403", "atlas_backup_forbidden"],
    ["atlas_admin_http_401", "atlas_backup_auth_failed"],
    ["atlas_oauth_http_401", "atlas_backup_auth_failed"],
    ["atlas_oauth_http_403", "atlas_backup_auth_failed"],
    ["atlas_oauth_invalid_response", "atlas_backup_auth_failed"],
    ["atlas_admin_http_500", "atlas_backup_unavailable"],
    ["", "atlas_backup_unavailable"],
  ])("maps %s to %s", (code, expected) => {
    expect(_internals.backupErrorCode(atlasError(code))).toBe(expected);
  });
});

describe("BackupStatusService.atlasStatus", () => {
  test("reports not configured without calling anything", async () => {
    const status = await service({ atlas: null }).atlasStatus();
    expect(status).toMatchObject({
      configured: false,
      available: false,
      errorCode: "not_configured",
      freshness: "unknown",
    });
  });

  test("returns the snapshot age and freshness, cached for ten minutes", async () => {
    let now = T0;
    const atlas = { backupStatus: jest.fn(async () => backup()) };
    const svc = service({ atlas, now: () => now });

    const first = await svc.atlasStatus();
    expect(first).toMatchObject({
      configured: true,
      available: true,
      stale: false,
      errorCode: null,
      checkedAt: T0.toISOString(),
      freshness: "fresh",
      ageHours: 5,
      latestStatus: "completed",
      completedSnapshotCount: 31,
      pointInTime: { enabled: true, windowDays: 2 },
    });

    now = new Date(T0.getTime() + 9 * 60 * 1000);
    const cached = await svc.atlasStatus();
    expect(atlas.backupStatus).toHaveBeenCalledTimes(1);
    // Age is worked out at read time, so a cached result still ages.
    expect(cached.ageHours).toBe(5.2);

    now = new Date(T0.getTime() + 11 * 60 * 1000);
    await svc.atlasStatus();
    expect(atlas.backupStatus).toHaveBeenCalledTimes(2);
  });

  test("shares one Atlas call between concurrent readers", async () => {
    const atlas = { backupStatus: jest.fn(async () => backup()) };
    const svc = service({ atlas });
    await Promise.all([svc.atlasStatus(), svc.atlasStatus(), svc.atlasStatus()]);
    expect(atlas.backupStatus).toHaveBeenCalledTimes(1);
  });
});

describe("backup schedule health bands", () => {
  test("uses the shortest backup schedule for health bands and admin copy", async () => {
    const atlas = { backupStatus: async () => backup({
      lastSnapshotAt: new Date(T0.getTime() - 15 * HOUR).toISOString(),
      retention: [
        { frequency: "daily", everyHours: null },
        { frequency: "hourly", everyHours: 6 },
      ],
    }) };
    const result = await service({ atlas }).adminSnapshot();
    expect(result.thresholds).toEqual({ freshMaxHours: 8, agingMaxHours: 14 });
    expect(result.atlas.freshness).toBe("stale");
    expect(_internals.backupFreshness(7.9, result.thresholds)).toBe("fresh");
    expect(_internals.backupFreshness(8, result.thresholds)).toBe("aging");
    expect(_internals.backupFreshness(14, result.thresholds)).toBe("stale");
  });

  test("falls back to daily bands when the schedule is missing or unreadable", () => {
    for (const retention of [undefined, [], [{ frequency: "hourly", everyHours: null }]]) {
      expect(_internals.backupThresholds(retention))
        .toEqual({ freshMaxHours: 26, agingMaxHours: 50 });
    }
  });
});

describe("BackupStatusService.atlasStatus failures", () => {
  test("explains a service account without Project Read Only", async () => {
    const atlas = {
      backupStatus: jest.fn(async () => {
        throw atlasError("atlas_admin_http_403");
      }),
    };
    const status = await service({ atlas }).atlasStatus();
    expect(status).toMatchObject({
      configured: true,
      available: false,
      errorCode: "atlas_backup_forbidden",
      freshness: "unknown",
      lastSnapshotAt: null,
    });
  });

  test("serves the last good result marked stale during an outage, then retries", async () => {
    let now = T0;
    const atlas = { backupStatus: jest.fn(async () => backup()) };
    const svc = service({ atlas, now: () => now });
    await svc.atlasStatus();

    atlas.backupStatus.mockImplementation(async () => {
      throw atlasError("atlas_admin_http_503");
    });
    now = new Date(T0.getTime() + 11 * 60 * 1000);
    const stale = await svc.atlasStatus();
    expect(stale).toMatchObject({
      available: true,
      stale: true,
      errorCode: "atlas_backup_unavailable",
      checkedAt: T0.toISOString(),
      freshness: "fresh",
    });

    // Within the one-minute retry window nothing is re-requested.
    now = new Date(now.getTime() + 30 * 1000);
    await svc.atlasStatus();
    expect(atlas.backupStatus).toHaveBeenCalledTimes(2);

    atlas.backupStatus.mockImplementation(async () => backup());
    now = new Date(now.getTime() + 60 * 1000);
    const recovered = await svc.atlasStatus();
    expect(atlas.backupStatus).toHaveBeenCalledTimes(3);
    expect(recovered).toMatchObject({ stale: false, errorCode: null });
  });
});

describe("BackupStatusService.inAppCounts", () => {
  test("counts snapshots and users without reading snapshot payloads", async () => {
    const newest = new Date("2026-08-10T09:00:00.000Z");
    const db = fakeDb({
      count: 42,
      userIds: ["u1", "u2", "u3"],
      newest,
      storageSize: 7_340_032,
    });
    const counts = await service({ db }).inAppCounts();
    expect(counts).toEqual({
      snapshotCount: 42,
      userCount: 3,
      newestAt: newest.toISOString(),
      storageBytes: 7_340_032,
    });
    expect(db.userBackups.find).toHaveBeenCalledWith(
      {},
      { projection: { _id: 0, createdAt: 1 } },
    );
    expect(db.db.command).toHaveBeenCalledWith(
      expect.objectContaining({ collStats: "user_backups" }),
    );
  });

  test("reports zero bytes before the first snapshot exists", async () => {
    const db = fakeDb({ statsError: Object.assign(new Error("ns"), { codeName: "NamespaceNotFound" }) });
    expect(await service({ db }).inAppCounts()).toEqual({
      snapshotCount: 0,
      userCount: 0,
      newestAt: null,
      storageBytes: 0,
    });
  });

  test("adminSnapshot keeps the Atlas card when the counts fail", async () => {
    const db = fakeDb();
    db.userBackups.distinct.mockRejectedValue(new Error("mongo down"));
    const result = await service({ db }).adminSnapshot();
    expect(result.inApp).toBeNull();
    expect(result.atlas.available).toBe(true);
    expect(result.thresholds).toEqual({ freshMaxHours: 26, agingMaxHours: 50 });
    expect(result.asOf).toBe(T0.toISOString());
  });
});

function events() {
  return { record: jest.fn(async (type, payload) => ({ eventId: "e1", type, payload })) };
}

describe("BackupStatusService.checkAndAlert", () => {

  test("raises one backup_stale event per day for an overdue snapshot", async () => {
    let now = T0;
    const adminEvents = events();
    const atlas = {
      backupStatus: jest.fn(async () => backup({
        lastSnapshotAt: new Date(T0.getTime() - 52 * HOUR).toISOString(),
      })),
    };
    const svc = service({ atlas, adminEvents, now: () => now });

    expect(await svc.checkAndAlert()).toEqual({ alerted: true, reason: "stale" });
    expect(adminEvents.record).toHaveBeenCalledWith(
      "backup_stale",
      {
        reason: "stale",
        lastSnapshotAt: new Date(T0.getTime() - 52 * HOUR).toISOString(),
        ageHours: 52,
        latestStatus: "completed",
      },
      { ingestionKey: "backup_stale:2026-08-11" },
    );

    now = new Date(T0.getTime() + HOUR);
    expect(await svc.checkAndAlert()).toEqual({
      alerted: false,
      reason: "already_alerted",
    });
    expect(adminEvents.record).toHaveBeenCalledTimes(1);

    now = new Date("2026-08-12T01:00:00.000Z");
    expect((await svc.checkAndAlert()).alerted).toBe(true);
    expect(adminEvents.record).toHaveBeenLastCalledWith(
      "backup_stale",
      expect.objectContaining({ reason: "stale" }),
      { ingestionKey: "backup_stale:2026-08-12" },
    );
  });

});

describe("BackupStatusService.checkAndAlert quiet cases", () => {
  test("alerts when Atlas has no completed snapshot at all", async () => {
    const adminEvents = events();
    const atlas = { backupStatus: jest.fn(async () => backup({ lastSnapshotAt: null })) };
    expect(await service({ atlas, adminEvents }).checkAndAlert())
      .toEqual({ alerted: true, reason: "missing" });
  });

  test.each([
    ["a fresh snapshot", { backupStatus: async () => backup() }, "fresh"],
    [
      "a late but not overdue snapshot",
      {
        backupStatus: async () => backup({
          lastSnapshotAt: new Date(T0.getTime() - 30 * HOUR).toISOString(),
        }),
      },
      "aging",
    ],
    [
      "a status Atlas would not give",
      {
        backupStatus: async () => {
          throw atlasError("atlas_admin_http_403");
        },
      },
      "atlas_backup_forbidden",
    ],
  ])("stays quiet for %s", async (_label, atlas, reason) => {
    const adminEvents = events();
    expect(await service({ atlas, adminEvents }).checkAndAlert())
      .toEqual({ alerted: false, reason });
    expect(adminEvents.record).not.toHaveBeenCalled();
  });

  test("stays quiet without credentials", async () => {
    const adminEvents = events();
    expect(await service({ atlas: null, adminEvents }).checkAndAlert())
      .toEqual({ alerted: false, reason: "not_configured" });
  });
});

function registerObservedShutdownTests(logger) {
  function observedJob(checkAndAlert) {
    const insertOne = jest.fn(async () => ({}));
    const jobLedger = new JobLedger({ db: { jobRuns: { insertOne } } });
    const job = buildBackupHealthJob({
      backupStatus: { isConfigured: () => true, checkAndAlert },
      logger: logger(),
      jobLedger,
      firstCheckDelayMs: 1000,
    });
    return { job, insertOne };
  }

  test("observed idle stop does not require a settlement method on the ledger wrapper", async () => {
    const check = jest.fn(async () => ({ alerted: false, reason: "fresh" }));
    const { job, insertOne } = observedJob(check);
    await expect(job.stop()).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  test.each([false, true])("observed stop drains the single active check and cancels timers (failed=%s)", async (failed) => {
    jest.useFakeTimers();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const check = jest.fn(async () => {
      await gate;
      if (failed) throw Object.assign(new Error("Atlas unavailable"), { code: "atlas_backup_unavailable" });
      return { alerted: false, reason: "fresh" };
    });
    const { job, insertOne } = observedJob(check);
    let stopped = false;
    try {
      job.start();
      const running = job.runOnce(), joined = job.runOnce();
      const stopping = job.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(check).toHaveBeenCalledTimes(1);
      expect(insertOne).not.toHaveBeenCalled();
      release();
      await Promise.all([running, joined, stopping]);
      expect(stopped).toBe(true);
      expect(insertOne).toHaveBeenCalledTimes(1);
      expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({
        job: "backup-health", status: failed ? "error" : "ok",
        errorCode: failed ? "atlas_backup_unavailable" : null,
      }));
      await jest.advanceTimersByTimeAsync(2 * HOUR);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await job.stop();
      jest.useRealTimers();
    }
  });

}

describe("buildBackupHealthJob", () => {
  function logger() {
    const log = { info: jest.fn(), warn: jest.fn() };
    log.child = () => log;
    return log;
  }

  registerObservedShutdownTests(logger);

  test("does not start without the Atlas service account", () => {
    jest.useFakeTimers();
    try {
      const backupStatus = {
        isConfigured: () => false,
        checkAndAlert: jest.fn(),
      };
      const job = buildBackupHealthJob({ backupStatus, logger: logger() });
      job.start();
      jest.advanceTimersByTime(3 * HOUR);
      expect(backupStatus.checkAndAlert).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test("checks after boot and then every hour", async () => {
    jest.useFakeTimers();
    try {
      const backupStatus = {
        isConfigured: () => true,
        checkAndAlert: jest.fn(async () => ({ alerted: false, reason: "fresh" })),
      };
      const job = buildBackupHealthJob({
        backupStatus,
        logger: logger(),
        firstCheckDelayMs: 1000,
      });
      job.start();
      await jest.advanceTimersByTimeAsync(1000);
      expect(backupStatus.checkAndAlert).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(backupStatus.checkAndAlert).toHaveBeenCalledTimes(2);
      await job.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("logs a failed check instead of throwing", async () => {
    const log = logger();
    const job = buildBackupHealthJob({
      backupStatus: {
        isConfigured: () => true,
        checkAndAlert: async () => {
          throw new Error("boom");
        },
      },
      logger: log,
    });
    await job.runOnce();
    expect(log.warn).toHaveBeenCalledWith({ err: "boom" }, "backup_health_check_error");
  });
});
