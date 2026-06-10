import { describe, expect, it } from "vitest";
import { fmtEta, ERROR_CODE_COPY } from "../useImportStatus";
import { checklistVisible } from "../../onboarding/OnboardingChecklist";

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
