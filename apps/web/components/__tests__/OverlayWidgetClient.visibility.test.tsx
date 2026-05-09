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
 * Regression test for a real ladder-stream report: the scouting
 * widget kept hanging around long after a match ended because the
 * prior visibility rule suppressed the auto-hide timer for every
 * non-idle phase — including ``match_ended``. Streamers routinely
 * sit on the SC2 score screen for 30 s to several minutes, so the
 * widget stayed pinned that whole time.
 *
 * Fixed semantics: only the ACTIVE phases (``match_loading`` /
 * ``match_started`` / ``match_in_progress``) suppress the per-widget
 * natural timer. ``match_ended`` falls through to the natural 22 s
 * scouting timer / 6-minute opponent timer.
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
  // production it's React's ``useState`` setter, which never changes
  // its identity). A fresh inline callback per render would change
  // the effect's deps and trigger spurious re-runs.
  const outRef = useRef(visibleOut);
  outRef.current = visibleOut;
  const setVisible = useCallback((v: boolean) => {
    outRef.current.value = v;
  }, []);
  useWidgetVisibility(widget, live, liveGame, null, setVisible);
  return null;
}

describe("useWidgetVisibility — match_ended natural-timer behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scouting widget AUTO-HIDES on its 22 s timer even mid-match (does NOT pin)", () => {
    // Streamer feedback: the giant pre-game intel dossier sitting on
    // the OBS scene through 15 minutes of gameplay was overwhelming.
    // Scouting fades on its natural 22 s timer; opponent (smaller) is
    // the one that pins through the match for viewer context.
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
      vi.advanceTimersByTime(23_000);
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
    // Way past 22 s scouting natural timer + opponent's own 22 s —
    // pinned because phase is active.
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

  it("scouting widget AUTO-HIDES after match_ended (the streamer sits on the score screen)", () => {
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
    // The natural scouting timer is 22 s — push past it.
    act(() => {
      vi.advanceTimersByTime(23_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget AUTO-HIDES on its 22 s natural timer in match_ended", () => {
    // Reduced from 6 min — the 6-min hack was meant to bridge
    // queue-into-next-match gaps, but now we clear ``live`` on
    // ``match_loading`` so the dossier swaps to the new opponent
    // automatically. 22 s parity with scouting clears the OBS scene
    // promptly when the streamer steps away after a game.
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
      vi.advanceTimersByTime(23_000);
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
    // 60 s into the match — still pinned.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(out.value).toBe(true);
    // Game ends — timer arms for the natural 22 s.
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
      vi.advanceTimersByTime(23_000);
    });
    expect(out.value).toBe(false);
  });

  it("opponent widget: transitioning from match_ended back to match_loading (rematch) re-pins immediately", () => {
    const out = { value: false };
    const { rerender } = render(
      <VisibilityProbe
        widget="opponent"
        live={liveOf()}
        liveGame={envelope({ phase: "match_ended" })}
        visibleOut={out}
      />,
    );
    // Almost time out, then a rematch loads.
    act(() => {
      vi.advanceTimersByTime(20_000);
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
    // Push way past the natural 22 s timer — opponent stays pinned
    // because the phase is active.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(out.value).toBe(true);
  });
});
