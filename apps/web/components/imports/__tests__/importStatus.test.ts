import { describe, expect, it } from "vitest";
import {
  fmtEta,
  foldEtaSample,
  ERROR_CODE_COPY,
  mergeProgressEvent,
  type ProgressSample,
} from "../useImportStatus";
import { checklistVisible } from "../../onboarding/OnboardingChecklist";

describe("mergeProgressEvent", () => {
  it("merges same-job events over the accumulated delta", () => {
    const prev = { jobId: "a", completed: 10, errors: 1 };
    const next = mergeProgressEvent(prev, { jobId: "a", completed: 12 }, "a");
    expect(next).toMatchObject({ completed: 12, errors: 1 });
  });

  it("never merges an event for a different job", () => {
    // Agent restarted mid-backfill and a stale reporter kept posting
    // for the old job — mixing two jobs' counters made the progress
    // card's numbers run backwards and forwards.
    const prev = { jobId: "a", completed: 3000, errors: 18 };
    const next = mergeProgressEvent(prev, { jobId: "b", completed: 3 }, "a");
    expect(next).toBe(prev);
  });

  it("keeps counters monotonic within a job", () => {
    // Socket delivery reorders around reconnects, and a restarted
    // agent re-reports from a lower absolute count — a lower value
    // must never yank the bar backwards.
    const prev = { jobId: "a", completed: 3000, errors: 18 };
    const next = mergeProgressEvent(
      prev,
      { jobId: "a", completed: 5, errors: 0, phase: "import" },
      "a",
    );
    expect(next).toMatchObject({
      completed: 3000,
      errors: 18,
      phase: "import",
    });
  });

  it("accepts events without a jobId and seeds from null", () => {
    expect(mergeProgressEvent(null, { completed: 1 }, "a")).toMatchObject({
      completed: 1,
    });
    const prev = { completed: 2 };
    expect(mergeProgressEvent(prev, { completed: 4 }, null)).toMatchObject({
      completed: 4,
    });
  });
});

describe("foldEtaSample (rolling-rate ETA)", () => {
  // Drive a sequence of readings through the fold, threading the window.
  function run(
    readings: Array<{ t: number; processed: number; total: number }>,
    opts?: { windowMs?: number; maxSamples?: number },
  ) {
    let samples: ProgressSample[] = [];
    let etaSeconds: number | null = null;
    for (const r of readings) {
      ({ samples, etaSeconds } = foldEtaSample(samples, r, opts));
    }
    return { samples, etaSeconds };
  }

  it("returns null until it has two points with forward movement", () => {
    const { etaSeconds } = run([{ t: 0, processed: 0, total: 1000 }]);
    expect(etaSeconds).toBeNull();
  });

  it("derives ETA from the recent rate, independent of startedAt", () => {
    // 100 files over 10s → 10/s; 900 remaining → 90s. The job could have
    // "started" hours ago — the rolling window never looks at that.
    const { etaSeconds } = run([
      { t: 0, processed: 0, total: 1000 },
      { t: 10_000, processed: 100, total: 1000 },
    ]);
    expect(etaSeconds).toBe(90);
  });

  it("returns null when nothing is moving (no divide-by-tiny-rate)", () => {
    const { etaSeconds } = run([
      { t: 0, processed: 100, total: 1000 },
      { t: 5_000, processed: 100, total: 1000 },
    ]);
    expect(etaSeconds).toBeNull();
  });

  it("survives an agent counter reset without an absurd ETA", () => {
    // Original run reaches 2500/10000 at a healthy clip...
    let samples: ProgressSample[] = [];
    let etaSeconds: number | null = null;
    ({ samples, etaSeconds } = foldEtaSample(samples, {
      t: 0,
      processed: 2000,
      total: 10_000,
    }));
    ({ samples, etaSeconds } = foldEtaSample(samples, {
      t: 50_000,
      processed: 2500,
      total: 10_000,
    }));
    expect(etaSeconds).not.toBeNull();

    // ...then the agent restarts: counters collapse to 61 while the
    // server's startedAt is unchanged. The stale window is discarded, so
    // we withhold an ETA rather than emit the ~339h the old startedAt
    // math produced.
    ({ samples, etaSeconds } = foldEtaSample(samples, {
      t: 60_000,
      processed: 61,
      total: 10_000,
    }));
    expect(etaSeconds).toBeNull();

    // The fresh run measures its own rate: 61 → 561 over 10s = 50/s.
    ({ samples, etaSeconds } = foldEtaSample(samples, {
      t: 70_000,
      processed: 561,
      total: 10_000,
    }));
    expect(etaSeconds).toBe(Math.round((10_000 - 561) / ((561 - 61) / 10)));
    expect(etaSeconds!).toBeLessThan(60 * 60); // minutes, not hundreds of hours
  });

  it("ages out samples older than the window", () => {
    const { samples, etaSeconds } = run(
      [
        { t: 0, processed: 0, total: 1000 },
        { t: 5_000, processed: 50, total: 1000 },
        { t: 30_000, processed: 300, total: 1000 },
      ],
      { windowMs: 10_000 },
    );
    // The t=0 sample is >10s older than the newest and gets dropped; the
    // rate is measured over the surviving recent window.
    expect(samples.length).toBe(2);
    expect(samples[0].t).toBe(5_000);
    expect(etaSeconds).toBe(Math.round((1000 - 300) / ((300 - 50) / 25)));
  });
});

describe("fmtEta", () => {
  it("renders null, sub-minute, minutes, and hours", () => {
    expect(fmtEta(null)).toBeNull();
    expect(fmtEta(20)).toBe("under a minute left");
    expect(fmtEta(6 * 60)).toBe("~6 min left");
    expect(fmtEta(60 * 60)).toBe("~1h left");
    expect(fmtEta(60 * 60 + 30 * 60)).toBe("~1h 30m left");
  });
});

describe("ERROR_CODE_COPY", () => {
  it("covers every agent skip-reason in the shared contract", () => {
    // Mirrors apps/agent replay_pipeline SKIP_* + import_controller
    // codes. A new code without copy renders an empty explanation.
    for (const code of [
      "parse_failed",
      "player_unresolved",
      "no_result",
      "ai_game",
      "filtered",
      "rejected_by_server",
    ]) {
      expect(ERROR_CODE_COPY[code]).toBeTruthy();
    }
  });
});

describe("checklistVisible", () => {
  const base = { games: { total: 0 }, agentPaired: false };

  it("shows for a brand-new user", () => {
    expect(checklistVisible({ ...base })).toBe(true);
  });

  it("shows while paired but no games yet", () => {
    expect(
      checklistVisible({ ...base, agentPaired: true }),
    ).toBe(true);
  });

  it("shows when games exist but nothing is paired (manual import edge)", () => {
    expect(
      checklistVisible({ ...base, games: { total: 5 } }),
    ).toBe(true);
  });

  it("hides once paired AND games have landed", () => {
    expect(
      checklistVisible({
        ...base,
        agentPaired: true,
        games: { total: 5 },
      }),
    ).toBe(false);
  });

  it("hides when dismissed regardless of progress", () => {
    expect(
      checklistVisible({
        ...base,
        onboarding: { dismissedAt: "2026-06-09T00:00:00Z" },
      }),
    ).toBe(false);
  });
});
