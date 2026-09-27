import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { useArcadeState } from "../hooks/useArcadeState";
import type { ArcadeState } from "../types";

/**
 * Hook-level regression for the unreachable Collection badges: plays and
 * settlements recorded through useArcadeState must award them, in the
 * same write as the play that completes the run.
 */

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: false, // unsigned skips network flush — purely-local exercise
    getToken: async () => null,
  }),
}));

let captured: ReturnType<typeof useArcadeState> | null = null;
let lastState: ArcadeState | null = null;

function Probe() {
  const hook = useArcadeState();
  useEffect(() => {
    captured = hook;
    lastState = hook.state;
  });
  return null;
}

function playOn(day: string, modeId: string, correct: boolean) {
  vi.setSystemTime(new Date(`${day}T15:00:00Z`));
  act(() => {
    captured!.recordPlay({ modeId, tz: "UTC", xp: 10, raw: correct ? 1 : 0, correct });
  });
}

describe("badges earned through useArcadeState", () => {
  beforeEach(() => {
    captured = null;
    lastState = null;
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("Closer's Eye on five consecutive days earns Closer", () => {
    render(<Probe />);
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      playOn(day, "closers-eye", true);
    }
    expect(lastState!.badges.closer).toBeUndefined();
    playOn("2026-09-05", "closers-eye", true);
    expect(lastState!.badges.closer).toBeDefined();
    expect(lastState!.records["closers-eye"].attempts).toBe(5);
  });

  test("a wrong Loss-Pattern Sleuth answer resets Detective progress", () => {
    render(<Probe />);
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      playOn(day, "loss-pattern-sleuth", true);
    }
    playOn("2026-09-04", "loss-pattern-sleuth", false);
    playOn("2026-09-05", "loss-pattern-sleuth", true);
    expect(lastState!.badges.detective).toBeUndefined();
  });

  test("three straight Streak Veto answers earn Veto Sleuth", () => {
    render(<Probe />);
    playOn("2026-09-01", "streak-veto", true);
    playOn("2026-09-01", "streak-veto", true);
    expect(lastState!.badges["veto-sleuth"]).toBeUndefined();
    playOn("2026-09-02", "streak-veto", true);
    expect(lastState!.badges["veto-sleuth"]).toBeDefined();
  });

  test("five green Stock Market weeks earn Tycoon", () => {
    render(<Probe />);
    act(() => {
      for (const wk of ["2026-W35", "2026-W36", "2026-W37", "2026-W38", "2026-W39"]) {
        captured!.settleStockMarket(wk, 1.2);
      }
    });
    expect(lastState!.badges.tycoon).toBeDefined();
    expect(Object.keys(lastState!.stockMarketHistory ?? {})).toHaveLength(5);
  });
});
