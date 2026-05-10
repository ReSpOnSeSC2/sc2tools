import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { useArcadeState } from "../hooks/useArcadeState";
import type { ArcadeState } from "../types";

/**
 * The records map is the single source of truth for the My Stats
 * "Per-mode records" surface. The bug being regressed here: in game
 * modes, the runner only called recordPlay on outcome==="correct",
 * so attempts/correct counters stayed at 0 for every user who ever
 * lost a Buildle / Stock-Market / Bingo round.
 *
 * We test the recorder directly via the hook — covering both the
 * "correct" and "wrong" paths and the multi-call dedupe behavior.
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

describe("Per-mode records tracking", () => {
  beforeEach(() => {
    captured = null;
    lastState = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("recordPlay increments attempts even when the outcome is wrong", () => {
    render(<Probe />);
    expect(captured).toBeTruthy();
    const c = captured!;
    act(() => {
      c.recordPlay({
        modeId: "buildle",
        tz: "UTC",
        xp: 0,
        raw: 0,
        correct: false,
      });
    });
    expect(lastState).toBeTruthy();
    const rec = lastState!.records["buildle"];
    expect(rec).toBeDefined();
    expect(rec.attempts).toBe(1);
    expect(rec.correct).toBe(0);
    expect(rec.bestRaw).toBe(0);
  });

  test("recordPlay increments correct + attempts on a correct outcome", () => {
    render(<Probe />);
    const c = captured!;
    act(() => {
      c.recordPlay({
        modeId: "two-truths-lie",
        tz: "UTC",
        xp: 16,
        raw: 1,
        correct: true,
      });
    });
    const rec = lastState!.records["two-truths-lie"];
    expect(rec.attempts).toBe(1);
    expect(rec.correct).toBe(1);
    expect(rec.bestRaw).toBe(1);
    expect(rec.bestXp).toBe(16);
  });

  test("repeated calls accumulate across attempts; bestRaw is a max", () => {
    render(<Probe />);
    const c = captured!;
    act(() => {
      c.recordPlay({
        modeId: "rivalry-ranker",
        tz: "UTC",
        xp: 4,
        raw: 0.25,
        correct: false,
      });
      c.recordPlay({
        modeId: "rivalry-ranker",
        tz: "UTC",
        xp: 12,
        raw: 1,
        correct: true,
      });
      c.recordPlay({
        modeId: "rivalry-ranker",
        tz: "UTC",
        xp: 6,
        raw: 0.5,
        correct: false,
      });
    });
    const rec = lastState!.records["rivalry-ranker"];
    expect(rec.attempts).toBe(3);
    expect(rec.correct).toBe(1);
    expect(rec.bestRaw).toBe(1);
    expect(rec.bestXp).toBe(12);
  });

  test("bestRun is the per-mode high-water mark when supplied", () => {
    render(<Probe />);
    const c = captured!;
    act(() => {
      c.recordPlay({ modeId: "stock-market", tz: "UTC", xp: 15, raw: 1, correct: true, bestRun: 7 });
      c.recordPlay({ modeId: "stock-market", tz: "UTC", xp: 15, raw: 1, correct: true, bestRun: 3 });
    });
    const rec = lastState!.records["stock-market"];
    expect(rec.bestRun).toBe(7);
  });
});
