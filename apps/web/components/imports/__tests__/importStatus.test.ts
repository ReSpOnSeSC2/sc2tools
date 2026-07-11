import { describe, expect, it } from "vitest";
import {
  fmtEta,
  ERROR_CODE_COPY,
  mergeProgressEvent,
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
