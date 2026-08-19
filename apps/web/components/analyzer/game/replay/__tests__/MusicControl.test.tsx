/**
 * The score's stateful half: the audio graph, the autoplay gesture,
 * the fades, the loop crossfade, the failure paths, and the two
 * controls in the transport dock.
 *
 * jsdom has neither Web Audio nor a media pipeline, so both are faked
 * here — deliberately as GLOBALS (``window.AudioContext`` /
 * ``window.Audio``) rather than through an injection seam, so the code
 * under test is the exact code that runs in a browser.
 *
 * Plain vitest assertions only: this repo has no jest-dom.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MUSIC_STORAGE_KEY,
  MUSIC_TUNING,
  ReplayMusicEngine,
  musicPlan,
  trackForSlot,
  trackUrl,
} from "@/lib/replayMusic";
import { ReplayStage } from "../ReplayStage";
import { payload } from "./fixtures";

/* ---------------------------------------------------------------- fakes */

class FakeParam {
  value = 0;
  ramps: { to: number; over: number }[] = [];
  constructor(private readonly ctx: FakeAudioContext) {}
  cancelScheduledValues(): this {
    return this;
  }
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, at: number): this {
    this.ramps.push({ to: v, over: at - this.ctx.currentTime });
    // The fake lands on the target immediately so assertions can read
    // the destination; ``ramps`` carries the shape that was requested.
    this.value = v;
    return this;
  }
  get last(): { to: number; over: number } | undefined {
    return this.ramps[this.ramps.length - 1];
  }
}

class FakeGain {
  gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    this.gain = new FakeParam(ctx);
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static failMediaSource = false;
  state = "suspended";
  currentTime = 0;
  destination = {};
  closed = false;
  gains: FakeGain[] = [];
  sources: unknown[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain(): FakeGain {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }
  createMediaElementSource(el: unknown): { connect(): void } {
    if (FakeAudioContext.failMediaSource) {
      // What a browser throws for a cross-origin element with no
      // Access-Control-Allow-Origin on the response.
      throw new Error("InvalidStateError: cross-origin media element");
    }
    this.sources.push(el);
    return { connect() {} };
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = "suspended";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static rejectPlayWith: string | null = null;
  src = "";
  preload = "";
  loop = true;
  crossOrigin: string | null = null;
  volume = 1;
  currentTime = 0;
  duration = NaN;
  playbackRate = 1;
  paused = true;
  playCount = 0;
  loadCount = 0;
  onerror: ((e?: unknown) => void) | null = null;
  oncanplay: (() => void) | null = null;
  constructor() {
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCount++;
    this.paused = false;
    if (FakeAudio.rejectPlayWith) {
      const err = new Error("blocked");
      err.name = FakeAudio.rejectPlayWith;
      return Promise.reject(err);
    }
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    this.loadCount++;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

type Mutable = Record<string, unknown>;

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.failMediaSource = false;
  FakeAudio.instances = [];
  FakeAudio.rejectPlayWith = null;
  window.localStorage.clear();
  (window as unknown as Mutable).AudioContext = FakeAudioContext;
  (window as unknown as Mutable).Audio = FakeAudio;
});

afterEach(() => {
  // globals:false => no automatic RTL cleanup; unmount first so the
  // engine's teardown runs before the fakes are removed.
  cleanup();
  delete (window as unknown as Mutable).AudioContext;
  delete (window as unknown as Mutable).Audio;
  vi.useRealTimers();
});

const ctx = (): FakeAudioContext => FakeAudioContext.instances[0];
/** Creation order in ``ensureGraph``: envelope, level, deck A, deck B. */
const ENVELOPE = 0;
const LEVEL = 1;
const DECK_A = 2;
const DECK_B = 3;

function startedEngine(race: string, seed = "seed-1") {
  let unavailable = 0;
  const engine = new ReplayMusicEngine({
    onUnavailable: () => {
      unavailable += 1;
    },
  });
  engine.setPlan(musicPlan(race, seed));
  engine.setPlayback(payload());
  engine.setVolume(0.5);
  return { engine, failures: () => unavailable };
}

/* ---------------------------------------------------------------- engine */

describe("ReplayMusicEngine — the autoplay gesture", () => {
  it("builds nothing at all until playback actually starts", () => {
    const { engine } = startedEngine("Terran");
    engine.setTime(120);
    engine.setSpeed(8);
    engine.setVolume(0.4);
    // No context, no element, no network request — a mounted replay
    // that is never played is completely silent machinery.
    expect(FakeAudioContext.instances.length).toBe(0);
    expect(FakeAudio.instances.length).toBe(0);

    engine.setPlaying(true);
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(FakeAudio.instances.length).toBe(2);
    engine.dispose();
  });

  it("resumes a suspended context rather than assuming it is running", () => {
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    expect(ctx().state).toBe("running");
    engine.dispose();
  });

  it("configures the element for a CORS-clean Web Audio source", () => {
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    for (const el of FakeAudio.instances) {
      expect(el.crossOrigin).toBe("anonymous");
      // Rotation is ours; the element must not loop itself.
      expect(el.loop).toBe(false);
      expect(el.preload).toBe("auto");
    }
    expect(FakeAudio.instances[0].src).toBe(
      trackUrl(trackForSlot("Terran", "seed-1", 0)),
    );
    expect(FakeAudio.instances[0].playCount).toBe(1);
    engine.dispose();
  });

  it("never touches playbackRate, whatever the replay speed", () => {
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    for (const speed of [1, 4, 8, 16]) {
      engine.setSpeed(speed);
      for (const el of FakeAudio.instances) expect(el.playbackRate).toBe(1);
    }
    engine.dispose();
  });
});

describe("ReplayMusicEngine — fades", () => {
  it("ramps in over two seconds instead of slamming the volume", () => {
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    const envelope = ctx().gains[ENVELOPE].gain;
    expect(envelope.last?.to).toBe(1);
    expect(envelope.last?.over).toBeCloseTo(MUSIC_TUNING.FADE_IN_SEC, 6);
    // Nothing anywhere assigns .volume on the element in this path.
    for (const el of FakeAudio.instances) expect(el.volume).toBe(1);
    engine.dispose();
  });

  it("fades out on pause and only stops the element afterwards", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    engine.setPlaying(false);
    const envelope = ctx().gains[ENVELOPE].gain;
    expect(envelope.last?.to).toBe(0);
    expect(envelope.last?.over).toBeCloseTo(MUSIC_TUNING.FADE_OUT_SEC, 6);
    // Still rolling: pausing here would cut the ramp off at its first
    // sample and produce exactly the click the fade exists to avoid.
    expect(FakeAudio.instances[0].paused).toBe(false);

    vi.advanceTimersByTime(MUSIC_TUNING.FADE_OUT_SEC * 1000 + 200);
    expect(FakeAudio.instances[0].paused).toBe(true);
    expect(ctx().state).toBe("suspended");
    engine.dispose();
  });

  it("picks the same element back up on the next play", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    engine.setPlaying(false);
    vi.advanceTimersByTime(2000);
    engine.setPlaying(true);
    expect(FakeAudioContext.instances.length).toBe(1); // no second context
    expect(FakeAudio.instances.length).toBe(2); // no second pair of elements
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(ctx().state).toBe("running");
    engine.dispose();
  });
});

describe("ReplayMusicEngine — battle-reactive gain", () => {
  it("pushes the pure score function onto the level node", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    const level = ctx().gains[LEVEL].gain;

    engine.setTime(60); // the fixture's only battle is at t = 155
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    const quiet = level.value;

    engine.setTime(155);
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    const loud = level.value;

    expect(quiet).toBeGreaterThan(0.49);
    expect(quiet).toBeLessThan(0.53);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud / quiet).toBeLessThan(1.35);
    // Scrub back out of the fight and it settles again — the level is
    // a function of the playhead, not a decaying envelope.
    engine.setTime(60);
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    expect(level.value).toBeCloseTo(quiet, 12);
    // …and every change was a ramp, never a step.
    expect(level.ramps.length).toBeGreaterThan(2);
    for (const r of level.ramps) {
      expect(r.over).toBeCloseTo(MUSIC_TUNING.LEVEL_RAMP_SEC, 6);
    }
    engine.dispose();
  });
});

describe("ReplayMusicEngine — looping", () => {
  it("crossfades into the NEXT track in the rotation, not a hard cut", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Protoss", "seed-1");
    engine.setPlaying(true);
    const [a, b] = FakeAudio.instances;
    const first = trackForSlot("Protoss", "seed-1", 0);
    const second = trackForSlot("Protoss", "seed-1", 1);
    expect(first.id).not.toBe(second.id);
    expect(a.src).toBe(trackUrl(first));

    // Sit the deck 12 s from the end: the next track is preloaded but
    // nothing is audible from it yet.
    a.currentTime = first.duration - 11;
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    expect(b.src).toBe(trackUrl(second));
    expect(b.playCount).toBe(0);

    // …and at the seam both decks play, ramping opposite ways.
    a.currentTime = first.duration - 1;
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    expect(b.playCount).toBe(1);
    expect(a.paused).toBe(false);
    const gainA = ctx().gains[DECK_A].gain;
    const gainB = ctx().gains[DECK_B].gain;
    expect(gainB.last?.to).toBe(1);
    expect(gainB.last?.over).toBeCloseTo(MUSIC_TUNING.CROSSFADE_SEC, 6);
    expect(gainA.last?.to).toBe(0);
    expect(gainA.last?.over).toBeCloseTo(MUSIC_TUNING.CROSSFADE_SEC, 6);

    // Only once the crossfade is over does the outgoing deck stop.
    vi.advanceTimersByTime(MUSIC_TUNING.CROSSFADE_SEC * 1000 + 200);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    engine.dispose();
  });
});

describe("ReplayMusicEngine — failure paths", () => {
  it("disables silently when the asset 404s", () => {
    const { engine, failures } = startedEngine("Terran");
    engine.setPlaying(true);
    expect(engine.available).toBe(true);

    act(() => {
      FakeAudio.instances[0].onerror?.(new Error("404"));
    });

    expect(failures()).toBe(1);
    expect(engine.available).toBe(false);
    expect(ctx().closed).toBe(true);
    for (const el of FakeAudio.instances) expect(el.paused).toBe(true);

    // And it stays down: no context is resurrected by later input.
    engine.setPlaying(false);
    engine.setPlaying(true);
    engine.setVolume(0.9);
    engine.setTime(300);
    expect(FakeAudioContext.instances.length).toBe(1);
  });

  it("falls back to element volume when the CDN sends no CORS header", () => {
    vi.useFakeTimers();
    FakeAudioContext.failMediaSource = true;
    const { engine, failures } = startedEngine("Terran");
    engine.setPlaying(true);

    // The context it opened is closed again rather than left dangling.
    expect(ctx().closed).toBe(true);
    // Music still plays — this is a degradation, not a failure.
    expect(failures()).toBe(0);
    expect(engine.available).toBe(true);
    expect(FakeAudio.instances[0].playCount).toBe(1);

    // The fade is stepped through the same ticker instead.
    vi.advanceTimersByTime(MUSIC_TUNING.FADE_IN_SEC * 1000 + 300);
    expect(FakeAudio.instances[0].volume).toBeCloseTo(0.5, 6);
    // No battle swell on this path: the level is the flat user volume.
    engine.setTime(155);
    vi.advanceTimersByTime(MUSIC_TUNING.TICK_MS + 5);
    expect(FakeAudio.instances[0].volume).toBeCloseTo(0.5, 6);
    engine.dispose();
  });

  it("stays enabled when a play() is merely blocked, and retries", () => {
    FakeAudio.rejectPlayWith = "NotAllowedError";
    const { engine, failures } = startedEngine("Terran");
    engine.setPlaying(true);
    return Promise.resolve().then(() => {
      expect(failures()).toBe(0);
      expect(engine.available).toBe(true);
      engine.dispose();
    });
  });

  it("gives up on an undecodable file", () => {
    FakeAudio.rejectPlayWith = "NotSupportedError";
    const { engine, failures } = startedEngine("Terran");
    engine.setPlaying(true);
    return Promise.resolve().then(() => {
      expect(failures()).toBe(1);
      expect(engine.available).toBe(false);
    });
  });
});

describe("ReplayMusicEngine — teardown", () => {
  it("closes the context, stops the elements and kills the ticker", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Terran");
    engine.setPlaying(true);
    const el = FakeAudio.instances[0];
    const playsBefore = el.playCount;

    engine.dispose();

    expect(ctx().closed).toBe(true);
    for (const e of FakeAudio.instances) {
      expect(e.paused).toBe(true);
      expect(e.src).toBe("");
      expect(e.onerror).toBe(null);
    }
    // Nothing is still ticking: five seconds later, nothing happened.
    vi.advanceTimersByTime(5000);
    expect(el.playCount).toBe(playsBefore);
    // Repeat disposal is a no-op rather than a throw.
    expect(() => engine.dispose()).not.toThrow();
  });

  it("opens exactly one context across a play / pause / play cycle", () => {
    vi.useFakeTimers();
    const { engine } = startedEngine("Zerg");
    for (let i = 0; i < 6; i++) {
      engine.setPlaying(true);
      vi.advanceTimersByTime(300);
      engine.setPlaying(false);
      vi.advanceTimersByTime(1500);
    }
    // Browsers cap concurrent AudioContexts at ~6; six play presses
    // must not spend the budget.
    expect(FakeAudioContext.instances.length).toBe(1);
    engine.dispose();
  });
});

/* ------------------------------------------------------------- controls */

describe("MusicControl in the transport dock", () => {
  const dock = () => within(screen.getByTestId("replay-transport"));

  it("renders a labelled toggle and a real range slider", () => {
    render(<ReplayStage playback={payload()} gameId="g1" myRace="Zerg" />);
    const group = screen.getByTestId("replay-music");
    expect(group.getAttribute("aria-label")).toBe("Replay music");
    const toggle = dock().getByRole("button", { name: /turn replay music off/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const slider = dock().getByRole("slider", { name: /replay music volume/i });
    expect(slider.getAttribute("type")).toBe("range");
    expect((slider as HTMLInputElement).value).toBe("35");
  });

  it("does not open an AudioContext on mount — only on the play gesture", () => {
    render(<ReplayStage playback={payload()} gameId="g1" myRace="Terran" />);
    expect(FakeAudioContext.instances.length).toBe(0);
    fireEvent.click(dock().getByRole("button", { name: /^play$/i }));
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(FakeAudio.instances[0].src).toBe(
      trackUrl(trackForSlot("Terran", "g1", 0)),
    );
  });

  it("treats switching music on mid-replay as the gesture", () => {
    window.localStorage.setItem(
      MUSIC_STORAGE_KEY,
      JSON.stringify({ enabled: false, volume: 0.35 }),
    );
    render(<ReplayStage playback={payload()} gameId="g1" myRace="Terran" />);
    fireEvent.click(dock().getByRole("button", { name: /^play$/i }));
    expect(FakeAudioContext.instances.length).toBe(0); // music is off

    fireEvent.click(dock().getByRole("button", { name: /turn replay music on/i }));
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(FakeAudio.instances[0].playCount).toBe(1);
  });

  it("persists off, and stays off on the next visit", () => {
    const { unmount } = render(
      <ReplayStage playback={payload()} gameId="g1" myRace="Terran" />,
    );
    fireEvent.click(dock().getByRole("button", { name: /turn replay music off/i }));
    expect(
      JSON.parse(window.localStorage.getItem(MUSIC_STORAGE_KEY) || "{}").enabled,
    ).toBe(false);
    unmount();

    render(<ReplayStage playback={payload()} gameId="g1" myRace="Terran" />);
    const toggle = dock().getByRole("button", { name: /turn replay music on/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // …and playing the replay now starts nothing.
    fireEvent.click(dock().getByRole("button", { name: /^play$/i }));
    expect(FakeAudioContext.instances.length).toBe(0);
  });

  it("persists the volume across a remount", () => {
    const { unmount } = render(
      <ReplayStage playback={payload()} gameId="g1" myRace="Terran" />,
    );
    fireEvent.change(dock().getByRole("slider", { name: /replay music volume/i }), {
      target: { value: "70" },
    });
    expect(
      JSON.parse(window.localStorage.getItem(MUSIC_STORAGE_KEY) || "{}").volume,
    ).toBeCloseTo(0.7, 6);
    unmount();

    render(<ReplayStage playback={payload()} gameId="g1" myRace="Terran" />);
    const slider = dock().getByRole("slider", { name: /replay music volume/i });
    expect((slider as HTMLInputElement).value).toBe("70");
  });

  it("renders itself inert — and leaves the replay alone — when the asset fails", () => {
    render(<ReplayStage playback={payload()} gameId="g1" myRace="Terran" />);
    fireEvent.click(dock().getByRole("button", { name: /^play$/i }));

    act(() => {
      FakeAudio.instances[0].onerror?.(new Error("404"));
    });

    expect(
      dock().getByRole("button", { name: /replay music unavailable/i }),
    ).toBeTruthy();
    expect(
      dock().queryByRole("slider", { name: /replay music volume/i }),
    ).toBe(null);
    // The replay itself is untouched: still scrubbable, still playing.
    const scrub = dock().getByRole("slider", { name: /playback position/i });
    fireEvent.change(scrub, { target: { value: "120" } });
    expect(dock().getByText("2:00 / 10:00")).toBeTruthy();
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
  });

  it("closes its context when the stage unmounts", () => {
    const { unmount } = render(
      <ReplayStage playback={payload()} gameId="g1" myRace="Terran" />,
    );
    fireEvent.click(dock().getByRole("button", { name: /^play$/i }));
    expect(ctx().closed).toBe(false);
    unmount();
    expect(ctx().closed).toBe(true);
  });

  it("gives the same replay the same track every time it is opened", () => {
    const opened: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { unmount } = render(
        <ReplayStage playback={payload()} gameId="tvp-9912" myRace="Protoss" />,
      );
      fireEvent.click(dock().getByRole("button", { name: /^play$/i }));
      opened.push(FakeAudio.instances[FakeAudio.instances.length - 2].src);
      unmount();
    }
    expect(new Set(opened).size).toBe(1);
    expect(opened[0]).toContain("protoss-orbital-reliquary");
  });
});
