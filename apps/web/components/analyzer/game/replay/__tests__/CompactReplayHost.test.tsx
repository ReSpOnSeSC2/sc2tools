import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rawPayload } from "./fixtures";

// vitest.config.ts sets globals:false, so React Testing Library never
// registers its automatic cleanup -- without this every render stays
// mounted and the next query matches the previous test's DOM too.
afterEach(() => cleanup());

/**
 * The compact drilldown had no music at all: ``MusicControl`` only ever
 * lived in ``ReplayStage``'s transport dock, and the compact host
 * renders a bare ``MapReplayer``. These tests pin the two properties
 * that matter — the control is reachable, and the score is told to
 * start SYNCHRONOUSLY inside the play click, which is the user gesture
 * browsers demand before an AudioContext may run.
 */

const api = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false } as {
    data: unknown;
    isLoading: boolean;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => api.result,
}));

/** A fake score that records the call stack depth of ``setPlaying`` so
 *  a test can prove it happened inside the click, not in an effect. */
const music = vi.hoisted(() => ({
  setPlaying: vi.fn(),
  setEnabled: vi.fn(),
  setVolume: vi.fn(),
  /** Args each hook render was called with. */
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/replayMusic", () => ({
  useReplayMusic: (args: Record<string, unknown>) => {
    music.calls.push(args);
    return {
      enabled: true,
      volume: 0.5,
      available: true,
      track: { title: "Harness Theme", mood: "calm" },
      setEnabled: music.setEnabled,
      setVolume: music.setVolume,
      setPlaying: music.setPlaying,
    };
  },
}));

const { MapReplaySection } = await import("../../MapReplaySection");

describe("the compact drilldown host", () => {
  beforeEach(() => {
    api.result = { data: rawPayload(), isLoading: false };
    music.setPlaying.mockClear();
    music.setEnabled.mockClear();
    music.setVolume.mockClear();
    music.calls.length = 0;
  });

  it("renders the music control alongside the bare replayer", () => {
    render(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
    const strip = screen.getByTestId("replay-compact-controls");
    expect(within(strip).getByTestId("replay-music")).toBeTruthy();
    expect(
      within(strip).getByRole("button", { name: /turn replay music off/i }),
    ).toBeTruthy();
    expect(
      within(strip).getByRole("slider", { name: /replay music volume/i }),
    ).toBeTruthy();
  });

  it("still brings NO rails, no top bar and no dock into the drilldown", () => {
    render(<MapReplaySection gameId="g1" compact />);
    expect(screen.queryByTestId("replay-stage")).toBeFalsy();
    expect(screen.queryByTestId("replay-top-bar")).toBeFalsy();
    expect(screen.queryByTestId("replay-production-rail")).toBeFalsy();
    expect(screen.queryByTestId("replay-build-order-rail")).toBeFalsy();
    expect(screen.queryByTestId("replay-transport")).toBeFalsy();
    // …and keeps what the drilldown has always had.
    expect(screen.getByTestId("loss-panel-you")).toBeTruthy();
    expect(screen.getByTestId("loss-panel-opponent")).toBeTruthy();
  });

  it("feeds the score ONE clock, shared with the canvas", () => {
    render(<MapReplaySection gameId="g1" compact />);
    const first = music.calls[0];
    expect(first.gameId).toBe("g1");
    expect(first.time).toBe(0);
    expect(first.speed).toBe(8);
    expect(first.playback).toBeTruthy();

    // A scrub on the replayer's own scrubber must reach the score.
    fireEvent.change(screen.getByRole("slider", { name: /playback position/i }), {
      target: { value: "150" },
    });
    expect(music.calls[music.calls.length - 1].time).toBe(150);
  });

  it("passes the player's race through so the score picks the right plan", () => {
    render(<MapReplaySection gameId="g1" compact myRace="Zerg" />);
    expect(music.calls[0].myRace).toBe("Zerg");
  });

  it("starts the score SYNCHRONOUSLY inside the play click", () => {
    render(<MapReplaySection gameId="g1" compact />);
    const play = screen.getByRole("button", { name: /▶ Play/ });

    // The gesture check: setPlaying must already have been called by the
    // time dispatchEvent returns, i.e. while the click is still on the
    // stack. An effect reacting to ``playing`` would run after this.
    let calledDuringClick = false;
    // On ``document``, bubble phase: React 19 delegates to the render
    // container, which is INSIDE document, so this runs after React's
    // handler but while the click event is still being dispatched.
    const probe = () => {
      calledDuringClick = music.setPlaying.mock.calls.length > 0;
    };
    document.addEventListener("click", probe);
    fireEvent.click(play);
    document.removeEventListener("click", probe);
    expect(calledDuringClick).toBe(true);
    expect(music.setPlaying).toHaveBeenCalledWith(true);
  });

  it("tells the score to stop on the second click", () => {
    render(<MapReplaySection gameId="g1" compact />);
    fireEvent.click(screen.getByRole("button", { name: /▶ Play/ }));
    fireEvent.click(screen.getByRole("button", { name: /❚❚ Pause/ }));
    expect(music.setPlaying.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("leaves the full-page host untouched", () => {
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByTestId("replay-stage")).toBeTruthy();
    expect(screen.queryByTestId("replay-compact-controls")).toBeFalsy();
    // The dock's own copy of the control is still the one there.
    expect(
      within(screen.getByTestId("replay-transport")).getByTestId("replay-music"),
    ).toBeTruthy();
  });
});
