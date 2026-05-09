import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useCallback, useRef } from "react";
import { useWidgetVisibility } from "../OverlayWidgetClient";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "../overlay/types";
import type { WidgetId } from "../overlay/widgetLifecycle";

/**
 * Regression tests for the post-game visibility lifecycle. Two
 * streamer-reported bugs that this hook needs to keep fixed:
 *
 *   1. Scouting dossier "stays on screen way too long" — the prior
 *      rule pinned scouting through every non-idle phase, so the
 *      widget hung around for the whole match (and several minutes
 *      of post-game score-screen) instead of fading after the
 *      pre-game flash.
 *   2. Match-result chip lingers — natural 15 s timer must run on
 *      the post-game ``LiveGamePayload``.
 *
 * The hook now suppresses the timer ONLY for the opponent widget
 * during ACTIVE match phases (loading / started / in-progress).
 * Scouting + everything else use the natural per-widget duration.
 */

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  };
}

function liveOf(extra: Partial<LiveGamePayload> = {}): LiveGamePayload {
  return {
    oppName: "Opponent",
    oppRace: "Terran",
    ...extra,
  };
}

function VisibilityProbe({
  widget,
  live,
  liveGame,
  visibleOut,
}: {
  widget: WidgetId;
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  visibleOut: { value: boolean };
}) {
  // The hook expects a referentially stable ``setVisible`` (in
  // production it's React's ``useState`` setter). A fresh inline
  // callback per render would change the effect's deps and trigger
  // spurious re-runs.
  const outRef = useRef(visibleOut);
  outRef.current = visibleOut;
  const setVisible = useCallback((v: boolean) => {
    outRef.current.value = v;
  }, []);
  useWidgetVisibility(widget, live, liveGame, null, setVisible);
  return null;
}

describe("useWidgetVisibility — post-game timer behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scouting widget AUTO-HIDES on its 15 s natural timer mid-match (NOT pinned)", () => {
    // Streamer feedback: the giant pre-game intel dossier sitting on
    // the OBS scene through 15 minutes of gameplay was overwhelming.
    // Scouting fades on its natural 15 s timer; only opponent pins.
    const out = { value: false };
    render(
      <VisibilityProbe
        widget="scouting"
        live={null}
        liveGame={envelope({ phase: "match_started" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget DOES pin through active phases (suppresses the timer)", () => {
    // The opponent widget is the small "name + race + MMR" identity
    // chip — small footprint, useful viewer context, fine to pin.
    const out = { value: false };
    const { rerender } = render(
      <VisibilityProbe
        widget="opponent"
        live={null}
        liveGame={envelope({ phase: "match_started" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    // Way past 15 s natural timer — pinned because phase is active.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(out.value).toBe(true);
    rerender(
      <VisibilityProbe
        widget="opponent"
        live={null}
        liveGame={envelope({ phase: "match_in_progress" })}
        visibleOut={out}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(out.value).toBe(true);
  });

  it("scouting widget AUTO-HIDES on match_ended (the streamer sits on the score screen)", () => {
    // match_ended is NOT in the active phase list, so the timer fires.
    const out = { value: false };
    render(
      <VisibilityProbe
        widget="scouting"
        live={liveOf()}
        liveGame={envelope({ phase: "match_ended" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget AUTO-HIDES on its 15 s natural timer in match_ended", () => {
    const out = { value: false };
    render(
      <VisibilityProbe
        widget="opponent"
        live={liveOf()}
        liveGame={envelope({ phase: "match_ended" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(out.value).toBe(false);
  });

  it("match-result widget AUTO-HIDES on its 15 s natural timer", () => {
    // match-result reads only from ``live`` (not liveGame), so the
    // timer arms immediately when a post-game payload lands.
    const out = { value: false };
    render(
      <VisibilityProbe
        widget="match-result"
        live={liveOf({ result: "win", mmrDelta: 18 })}
        liveGame={null}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget: transitioning from match_in_progress to match_ended re-arms the timer", () => {
    const out = { value: false };
    const { rerender } = render(
      <VisibilityProbe
        widget="opponent"
        live={liveOf()}
        liveGame={envelope({ phase: "match_in_progress" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(out.value).toBe(true);
    rerender(
      <VisibilityProbe
        widget="opponent"
        live={liveOf()}
        liveGame={envelope({ phase: "match_ended" })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget: rematch (match_ended → match_loading) re-pins immediately", () => {
    const out = { value: false };
    const { rerender } = render(
      <VisibilityProbe
        widget="opponent"
        live={liveOf()}
        liveGame={envelope({ phase: "match_ended" })}
        visibleOut={out}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(out.value).toBe(true);
    rerender(
      <VisibilityProbe
        widget="opponent"
        live={null}
        liveGame={envelope({
          phase: "match_loading",
          opponent: { name: "Negod" },
        })}
        visibleOut={out}
      />,
    );
    expect(out.value).toBe(true);
    // Way past 15 s — opponent stays pinned during active phase.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(out.value).toBe(true);
  });
});
