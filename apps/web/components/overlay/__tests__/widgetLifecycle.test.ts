import { describe, expect, it } from "vitest";
import {
  payloadTargetsWidget,
  resolveWidgetDurationMs,
  TEST_DURATION_MS,
  WIDGET_DURATION_MS,
} from "../widgetLifecycle";
import {
  BETWEEN_ACTS_MS,
  BUILD_EXIT_MS,
  BUILD_RESULT_HOLD_MS,
  UNIT_EXIT_MS,
  UNIT_RESULT_HOLD_MS,
} from "../../randomizer/RandomizerSequence";
import { FIGHTER_BRAWL_DURATION_MS } from "../../randomizer/reveals/FighterBrawlReveal";
import { BATTLE_ROYALE_MAX_DURATION_MS } from "../../randomizer/reveals/BattleRoyaleReveal";
import { HOLO_DRAFT_DURATION_MS } from "../../randomizer/unit-reveals/HoloDraftReveal";

describe("payloadTargetsWidget", () => {
  it("lets real-game and Test-all payloads reach every widget", () => {
    expect(payloadTargetsWidget({}, "opponent")).toBe(true);
    expect(payloadTargetsWidget({ isTest: true }, "ghost-build")).toBe(true);
  });

  it("isolates a Ghost Build probe to its dedicated source", () => {
    const probe = { isTest: true, testWidget: "ghost-build" };
    expect(payloadTargetsWidget(probe, "ghost-build")).toBe(true);
    expect(payloadTargetsWidget(probe, "opponent")).toBe(false);
    expect(payloadTargetsWidget(probe, "randomizer")).toBe(false);
  });
});

describe("randomizer lifecycle", () => {
  it("budgets enough production time for the build and unit reveal acts", () => {
    expect(WIDGET_DURATION_MS.randomizer).toBe(32_000);
    expect(resolveWidgetDurationMs("randomizer", false)).toBe(32_000);
  });

  it("still respects the shared short Test-fire cap", () => {
    expect(resolveWidgetDurationMs("randomizer", true)).toBe(TEST_DURATION_MS);
  });

  it("keeps the longest full two-act sequence inside the Test cap", () => {
    const longestBuildMs = Math.max(
      FIGHTER_BRAWL_DURATION_MS,
      BATTLE_ROYALE_MAX_DURATION_MS,
    );
    const longestSequenceMs =
      longestBuildMs +
      BUILD_RESULT_HOLD_MS +
      BUILD_EXIT_MS +
      BETWEEN_ACTS_MS +
      HOLO_DRAFT_DURATION_MS +
      UNIT_RESULT_HOLD_MS +
      UNIT_EXIT_MS;

    expect(longestSequenceMs).toBe(19_180);
    expect(longestSequenceMs).toBeLessThan(TEST_DURATION_MS);
    expect(longestSequenceMs).toBeLessThan(WIDGET_DURATION_MS.randomizer!);
  });
});
