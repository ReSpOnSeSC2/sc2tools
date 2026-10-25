// @ts-nocheck
"use strict";
const { MmrExpectationRecomputeJob, DAY_MS } = require("../src/jobs/mmrExpectationRecomputeJob");
const { RULE_VERSION } = require("../src/services/mmrExpectation");

function fixture() {
  const now = 1_800_000_000_000;
  const service = { readRun: jest.fn().mockResolvedValue(null), recompute: jest.fn().mockImplementation(async opts => { await opts.beforePublish(); return { method: "elo", sampleGames: 0, supportedBins: 0 }; }) };
  const logger = { warn: jest.fn() };
  const job = new MmrExpectationRecomputeJob({ db: { db: { collection: jest.fn() } }, mmrExpectation: service, logger, now: () => now, disabled: false });
  job.lock = { ensureIndexes: jest.fn().mockResolvedValue(), acquire: jest.fn().mockResolvedValue("owner-a"), extend: jest.fn().mockResolvedValue(true), release: jest.fn().mockResolvedValue() };
  return { job, service, logger, now };
}

describe("daily deterministic calibration scheduling", () => {
  afterEach(() => jest.useRealTimers());
  test("deploy starts with delayed freshness checks and stop cancels timers", async () => {
    jest.useFakeTimers(); const { job, service } = fixture(); job.start();
    await jest.advanceTimersByTimeAsync(14 * 60_000); expect(service.recompute).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000); expect(service.recompute).toHaveBeenCalledTimes(1);
    await job.stop(); await jest.advanceTimersByTimeAsync(DAY_MS); expect(service.recompute).toHaveBeenCalledTimes(1);
  });

  test("fresh same-rule result prevents a deploy rebuild, future/old-rule results do not", async () => {
    const { job, service, now } = fixture();
    service.readRun.mockResolvedValue({ updatedAt: new Date(now - DAY_MS + 1), ruleVersion: RULE_VERSION });
    expect(await job.runOnce()).toEqual({ ran: false, reason: "fresh" }); expect(job.lock.acquire).not.toHaveBeenCalled();
    service.readRun.mockResolvedValue({ updatedAt: new Date(now + 1), ruleVersion: RULE_VERSION });
    expect((await job.runOnce()).ran).toBe(true);
    service.readRun.mockResolvedValue({ updatedAt: new Date(now), ruleVersion: RULE_VERSION - 1 });
    expect((await job.runOnce()).ran).toBe(true);
  });

  test("disabled job never schedules, locks or scans", async () => {
    jest.useFakeTimers(); const { job, service } = fixture(); job.disabled = true; job.start();
    await jest.advanceTimersByTimeAsync(DAY_MS); expect(await job.runOnce()).toEqual({ ran: false, reason: "disabled" });
    expect(service.readRun).not.toHaveBeenCalled(); expect(job.lock.acquire).not.toHaveBeenCalled();
  });
});

describe("owner-safe single flight", () => {
  test("held lock and under-lock freshness recheck prevent duplicate scans", async () => {
    const { job, service, now } = fixture(); job.lock.acquire.mockResolvedValueOnce(null);
    expect(await job.runOnce()).toEqual({ ran: false, reason: "lock_held" }); expect(service.recompute).not.toHaveBeenCalled();
    service.readRun.mockResolvedValueOnce(null).mockResolvedValueOnce({ updatedAt: new Date(now), ruleVersion: RULE_VERSION });
    expect(await job.runOnce()).toEqual({ ran: false, reason: "fresh" }); expect(service.recompute).not.toHaveBeenCalled();
    expect(job.lock.release).toHaveBeenCalledWith("owner-a");
  });

  test("overlap shares one scan and only the acquired owner may publish", async () => {
    const { job, service } = fixture(); let finish;
    service.recompute.mockImplementation(opts => new Promise(resolve => { finish = async () => { await opts.beforePublish(); resolve({ method: "elo" }); }; }));
    const first = job.runOnce(), second = job.runOnce();
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
    await finish(); expect((await first).ran).toBe(true); expect(await second).toEqual(await first);
    expect(service.recompute).toHaveBeenCalledTimes(1); expect(job.lock.extend).toHaveBeenCalledWith("owner-a");
  });

  test("lost ownership aborts before publication, logs no account information, and releases by owner", async () => {
    const { job, service, logger } = fixture(); job.lock.extend.mockResolvedValue(false);
    expect(await job.runOnce()).toEqual({ ran: false, reason: "failed" }); expect(service.recompute).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ err: "mmr_expectation_lock_lost" }); expect(job.lock.release).toHaveBeenCalledWith("owner-a");
  });
});
